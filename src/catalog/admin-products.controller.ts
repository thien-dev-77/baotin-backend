import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, CategoryEntity, OrderEntity, ProductEntity } from "../database/entities";
import { IntegrationLinkEntity, InventoryEntity } from "../database/operations.entities";
import { runtimeAssetPath } from "../runtime-assets";
import type { Product } from "../types/domain.types";
import { ProductDto } from "./product.dto";
import { assertPublishable } from "./product.rules";

@Controller("admin/products")
export class AdminProductsController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService) {}

  @Post() create(@Body() input: ProductDto, @Req() request: AuthRequest) {
    return this.save(input, request);
  }

  @Patch(":id") update(@Param("id") id: string, @Body() input: ProductDto, @Req() request: AuthRequest) {
    if (!input.revision) throw new BadRequestException("Thiếu phiên bản sản phẩm. Làm mới và thử lại.");
    return this.save(input, request, id);
  }

  private async save(input: ProductDto, request: AuthRequest, id?: string) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return this.db.transaction(async manager => {
      const repository = manager.getRepository(ProductEntity);
      const previous = id ? await repository.findOneBy({ id }) : null;
      if (id && !previous) throw new NotFoundException("Không tìm thấy sản phẩm.");
      if (previous && previous.revision !== input.revision) throw new ConflictException("Sản phẩm đã thay đổi. Làm mới trước khi lưu.");
      const category = await manager.getRepository(CategoryEntity).findOneBy({ slug: input.category });
      if (!category || (input.subcategory && !category.data.subcategories.includes(input.subcategory))) throw new BadRequestException("Danh mục hoặc nhóm sản phẩm không hợp lệ.");
      const duplicate = await repository.createQueryBuilder("product")
        .where("(LOWER(TRIM(product.data->>'code')) = LOWER(:code) OR product.slug = :slug)", { code: input.code, slug: input.slug })
        .andWhere("product.id <> :id", { id: id || "" }).getOne();
      if (duplicate) throw new ConflictException("Mã hàng hoặc đường dẫn đã được sử dụng.");
      if (input.oldPrice != null && input.oldPrice < input.price) throw new BadRequestException("Giá trước giảm không được thấp hơn giá bán lẻ.");
      // SKU/unit are identities used by stock, order snapshots and Kiot mappings.
      if (previous && (previous.data.code !== input.code || previous.data.unit !== input.unit)) {
        const hasOrder = await manager.getRepository(OrderEntity).createQueryBuilder("orders")
          .where("orders.data->'items' @> :item::jsonb", { item: JSON.stringify([{ productId: id }]) }).getExists();
        const hasStock = previous.data.stock > 0 || await manager.getRepository(InventoryEntity).existsBy({ productId: id });
        const hasLink = await manager.getRepository(IntegrationLinkEntity).existsBy({ kind: "product", localId: id });
        if (hasOrder || hasStock || hasLink) throw new ConflictException("Không đổi mã hàng hoặc đơn vị khi sản phẩm đã có đơn, sổ kho hoặc liên kết KiotViet.");
      }
      for (const url of input.gallery) {
        const relative = url.startsWith("/images/") ? url.slice(1) : url.slice("/media/".length);
        try { await access(resolve(runtimeAssetPath(process.env.MEDIA_DIR || "media"), relative)); }
        catch { throw new BadRequestException("Ảnh không tồn tại trên backend. Vui lòng tải ảnh lại."); }
      }
      const { revision: _revision, published, ...fields } = input;
      const productId = previous?.id || randomUUID();
      const data: Product = { ...previous?.data, ...fields, oldPrice: input.oldPrice ?? undefined, id: productId, image: input.gallery[0] || "", stock: previous?.data.stock || 0 };
      if (published) assertPublishable(data);
      const row = await repository.save(repository.create({ ...previous, id: productId, slug: input.slug, published, data }));
      await manager.getRepository(AuditEntity).save({ actorId: user.id, action: previous ? "product-update" : "product-create", resourceId: row.id, detail: { published, code: data.code, revision: row.revision } });
      return { id: row.id, product: { ...data, published: row.published, revision: row.revision } };
    });
  }
}
