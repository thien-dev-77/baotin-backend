import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, ProductEntity } from "../database/entities";
import { assertProductImageExists } from "../media/product-media";
import { ProductVariantCopyDto } from "./product-variant-copy.dto";
import { assertPublishable } from "./product.rules";

@Injectable()
export class ProductVariantCopyService {
  constructor(private readonly db: DatabaseService) {}

  async apply(id: string, input: ProductVariantCopyDto, actorId: string) {
    if (input.products.some(product => product.id === id)) throw new BadRequestException("Chỉ chọn các SKU khác với sản phẩm nguồn.");

    return this.db.transaction(async manager => {
      const repository = manager.getRepository(ProductEntity);
      const source = await repository.createQueryBuilder("p").setLock("pessimistic_write").where("p.id = :id", { id }).getOne();
      if (!source) throw new NotFoundException("Không tìm thấy sản phẩm nguồn.");
      if (!source.data.variantGroupId) throw new BadRequestException("Sản phẩm nguồn chưa thuộc nhóm biến thể.");
      if (source.revision !== input.revision) throw new ConflictException("Sản phẩm nguồn đã thay đổi. Lưu hoặc tải lại trước khi áp dụng.");

      const rows = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .whereInIds(input.products.map(product => product.id)).orderBy("p.id", "ASC").getMany();
      if (rows.length !== input.products.length) throw new NotFoundException("Một SKU đã bị xóa. Tải lại nhóm biến thể trước khi áp dụng.");
      if (rows.some(row => row.data.variantGroupId !== source.data.variantGroupId)) throw new BadRequestException("Chỉ áp dụng cho các SKU cùng nhóm biến thể.");
      const revisions = new Map(input.products.map(product => [product.id, product.revision]));
      if (rows.some(row => row.revision !== revisions.get(row.id))) throw new ConflictException("Một SKU đã thay đổi ở phiên khác. Tải lại nhóm trước khi áp dụng.");

      // Select only common content. SKU identity, pricing, inventory and variant values stay on each target.
      const changes = Object.fromEntries(input.fields.map(field => [field, source.data[field] ?? (field === "gallery" ? [] : "")]));
      if (input.fields.includes("technicalDetails")) changes.specification = source.data.specification;
      if (input.fields.includes("gallery")) {
        const gallery = source.data.gallery || [];
        try { await Promise.all(gallery.map(assertProductImageExists)); }
        catch { throw new BadRequestException("Ảnh nguồn không còn tồn tại. Tải lại ảnh trước khi áp dụng."); }
        changes.image = gallery[0] || "";
      }
      for (const row of rows) {
        row.data = { ...row.data, ...changes };
        if (row.published) assertPublishable(row.data);
      }
      const saved = await repository.save(rows);
      await manager.getRepository(AuditEntity).save({ actorId, action: "product-variant-content-copy", resourceId: id,
        detail: { sourceRevision: source.revision, fields: input.fields, products: saved.map(row => ({ id: row.id, revision: row.revision })) } });
      return { updated: saved.length, products: saved.map(row => ({ id: row.id, code: row.data.code, revision: row.revision })) };
    });
  }
}
