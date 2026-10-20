import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, ProductEntity } from "../database/entities";
import { ProductVariantAttachDto } from "./product-variant-attach.dto";
import { MAX_BULK_PRODUCTS } from "./product-bulk.dto";
import { validateVariantGroupConfiguration, variantDimension } from "./product-variants";

@Injectable()
export class ProductVariantAttachService {
  constructor(private readonly db: DatabaseService) {}

  async apply(id: string, input: ProductVariantAttachDto, actorId: string) {
    return this.db.transaction(async manager => {
      const repository = manager.getRepository(ProductEntity);
      // Lock the anchor before all members, as in the other group operations.
      const root = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .where("p.id = :groupId", { groupId: input.groupId }).getOne();
      if (!root) throw new NotFoundException("Không tìm thấy sản phẩm gốc của nhóm.");
      if (root.data.variantGroupId && root.data.variantGroupId !== root.id) {
        throw new ConflictException("Nhóm biến thể đã thay đổi. Tải lại trước khi liên kết SKU.");
      }
      const rows = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .where("p.id = :groupId OR p.data->>'variantGroupId' = :groupId", { groupId: root.id })
        .orderBy("p.createdAt", "ASC").addOrderBy("p.id", "ASC").getMany();
      const revisions = new Map(input.products.map(product => [product.id, product.revision]));
      if (!rows.some(row => row.id === id) && !await repository.existsBy({ id })) throw new NotFoundException("Không tìm thấy sản phẩm đang sửa.");
      if (!rows.some(row => row.id === id) || rows.length !== revisions.size || rows.some(row => !revisions.has(row.id))) {
        throw new ConflictException("Danh sách SKU trong nhóm đã thay đổi. Tải lại trước khi liên kết SKU.");
      }
      if (rows.some(row => row.revision !== revisions.get(row.id))) {
        throw new ConflictException("Một SKU trong nhóm đã được cập nhật ở phiên khác. Tải lại trước khi liên kết SKU.");
      }
      if (rows.length >= MAX_BULK_PRODUCTS) throw new BadRequestException(`Nhóm biến thể có tối đa ${MAX_BULK_PRODUCTS} SKU.`);
      if (rows.some(row => row.id === input.targetId)) throw new BadRequestException("SKU đã nằm trong nhóm biến thể này.");
      const target = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .where("p.id = :targetId", { targetId: input.targetId }).getOne();
      if (!target) throw new NotFoundException("Không tìm thấy sản phẩm cần liên kết.");
      if (target.revision !== input.targetRevision) throw new ConflictException("Sản phẩm cần liên kết đã thay đổi. Tải lại trước khi tiếp tục.");
      const hasMembers = await repository.createQueryBuilder("p")
        .where("p.data->>'variantGroupId' = :targetId AND p.id <> :targetId", { targetId: target.id }).getExists();
      if (hasMembers || target.data.variantGroupId && target.data.variantGroupId !== target.id) {
        throw new BadRequestException(`SKU ${target.data.code} đang thuộc nhóm biến thể khác. Tách SKU khỏi nhóm đó trước khi liên kết.`);
      }
      const mismatch = (["brand", "category", "unit"] as const).filter(key => target.data[key] !== root.data[key]);
      if (mismatch.length) {
        const labels = { brand: "thương hiệu", category: "danh mục", unit: "đơn vị tính" };
        throw new BadRequestException(`SKU ${target.data.code} phải có cùng ${mismatch.map(key => labels[key]).join(", ")} với sản phẩm gốc.`);
      }
      const previous = rows.map(row => row.data);
      const anchor = { ...root.data, variantGroupId: root.id, variantAttributes: root.data.variantAttributes || [] };
      const linked = { ...target.data, variantGroupId: root.id, variantAttributes: input.attributes,
        size: variantDimension(input.attributes, "size") || target.data.size,
        color: variantDimension(input.attributes, "color") || target.data.color };
      const products = rows.map(row => row.id === root.id ? anchor : row.data);
      // Existing overlaps remain valid; the new SKU must have its own combination.
      validateVariantGroupConfiguration([...products, linked], anchor, previous);
      const changes = [target];
      target.data = linked;
      if (root.data.variantGroupId !== root.id || !root.data.variantAttributes) {
        root.data = anchor;
        changes.unshift(root);
      }
      const saved = await repository.save(changes);
      await manager.getRepository(AuditEntity).save({ actorId, action: "product-variant-attach", resourceId: target.id,
        detail: { groupId: root.id, fromProductId: id, products: saved.map(row => ({ id: row.id, revision: row.revision })) } });
      const byId = new Map(saved.map(row => [row.id, row]));
      return { groupId: root.id, products: [...rows, target].map(row => {
        const product = byId.get(row.id) || row;
        return { ...product.data, published: product.published, revision: product.revision };
      }) };
    });
  }
}
