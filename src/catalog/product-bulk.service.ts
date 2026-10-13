import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { In } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, CategoryEntity, ProductEntity } from "../database/entities";
import { assertProductImageExists } from "../media/product-media";
import { ProductBulkDto } from "./product-bulk.dto";
import { assertPublishable } from "./product.rules";
import { hasRetailPricing, resolveProductPricing } from "./product-pricing";

@Injectable()
export class ProductBulkService {
  constructor(private readonly db: DatabaseService) {}
  async apply(input: ProductBulkDto, actorId: string) {
    if (input.action === "discounts" && input.b2cDiscount === undefined && input.b2bDiscount === undefined) throw new BadRequestException("Chọn ít nhất một mức chiết khấu để cập nhật.");
    if (input.b2cDiscount === null || input.b2bDiscount === null) throw new BadRequestException("Chiết khấu không được để trống.");
    if (input.action !== "discounts" && (input.b2cDiscount !== undefined || input.b2bDiscount !== undefined)) throw new BadRequestException("Thao tác hiển thị không nhận chiết khấu.");
    return this.db.transaction(async manager => {
      const repository = manager.getRepository(ProductEntity);
      const rows = await repository.findBy({ id: In(input.products.map(item => item.id)) });
      if (rows.length !== input.products.length) throw new NotFoundException("Một số sản phẩm đã bị xóa. Làm mới danh sách trước khi cập nhật.");
      const versions = new Map(input.products.map(item => [item.id, item.revision]));
      const stale = rows.filter(row => row.revision !== versions.get(row.id));
      if (stale.length) throw new ConflictException(`Sản phẩm đã thay đổi: ${stale.slice(0, 5).map(row => row.data.code).join(", ")}. Làm mới và chọn lại trước khi cập nhật.`);
      const categories = await manager.getRepository(CategoryEntity).findBy({ slug: In([...new Set(rows.map(row => row.data.category))]) });
      const categoryBySlug = new Map(categories.map(row => [row.slug, row]));
      const skipped: { id: string; code: string; name: string; reason: string }[] = [];
      for (const row of rows) {
        if (input.action === "discounts") {
          if (!hasRetailPricing(row.data) || row.data.b2bDiscount === undefined) throw new BadRequestException(`Sản phẩm ${row.data.code} chưa cấu hình giá niêm yết và CK B2C/B2B. Hãy cấu hình trước khi sửa hàng loạt.`);
          row.data = { ...row.data, ...resolveProductPricing({ listPrice: row.data.listPrice, b2cDiscount: input.b2cDiscount ?? row.data.b2cDiscount, b2bDiscount: input.b2bDiscount ?? row.data.b2bDiscount }, row.data) };
        }
        if (input.action === "publish") {
          try {
            assertPublishable(row.data);
            const category = categoryBySlug.get(row.data.category);
            if (!category || (row.data.subcategory && !category.data.subcategories.includes(row.data.subcategory))) throw new BadRequestException("Danh mục hoặc nhóm sản phẩm không còn hợp lệ. Chọn lại trong trang sửa sản phẩm.");
            try { await Promise.all(row.data.gallery.map(assertProductImageExists)); }
            catch { throw new BadRequestException("Ảnh sản phẩm không tồn tại trên backend. Vui lòng tải lại ảnh."); }
          } catch (cause) {
            if (!(cause instanceof BadRequestException)) throw cause;
            skipped.push({ id: row.id, code: row.data.code, name: row.data.name, reason: cause.message });
            continue;
          }
        }
        if (input.action !== "discounts") row.published = input.action === "publish";
      }
      const skippedIds = new Set(skipped.map(product => product.id));
      const validRows = rows.filter(row => !skippedIds.has(row.id));
      const saved = validRows.length ? await repository.save(validRows) : [];
      const publishedCategories = new Set(saved.map(row => row.data.category));
      const hiddenCategories = input.action === "publish" ? categories.filter(category => publishedCategories.has(category.slug) && category.data.visible === false).map(category => category.data.name) : [];
      await manager.getRepository(AuditEntity).save({ actorId, action: `products-bulk-${input.action}`, resourceId: "products", detail: { products: saved.map(row => ({ id: row.id, revision: row.revision })), skipped, b2cDiscount: input.b2cDiscount, b2bDiscount: input.b2bDiscount } });
      return { updated: saved.length, action: input.action, products: saved.map(row => ({ id: row.id, revision: row.revision, published: row.published })), skipped, hiddenCategories };
    });
  }
}
