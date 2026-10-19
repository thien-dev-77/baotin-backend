import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthService, type AuthRequest } from "../auth/auth.service";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, CategoryEntity, OrderEntity, ProductEntity } from "../database/entities";
import { IntegrationLinkEntity, InventoryEntity } from "../database/operations.entities";
import { assertProductImageExists } from "../media/product-media";
import { ProductBulkDto, ProductSelectionDto } from "./product-bulk.dto";
import { ProductBulkService } from "./product-bulk.service";
import { AdminBrowseService } from "../admin/admin-browse.service";
import type { Product } from "../types/domain.types";
import { ProductDto } from "./product.dto";
import { ProductVariantGroupDto } from "./product-variant-group.dto";
import { ProductVariantCopyDto } from "./product-variant-copy.dto";
import { ProductVariantCopyService } from "./product-variant-copy.service";
import { ProductVariantDetachDto } from "./product-variant-detach.dto";
import { ProductVariantDetachService } from "./product-variant-detach.service";
import { assertPublishable } from "./product.rules";
import { resolveProductPricing } from "./product-pricing";
import { validateVariantGroup, validateVariantGroupConfiguration, attributeKey, variantDimension } from "./product-variants";

@Controller("admin/products")
export class AdminProductsController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService, private readonly bulk: ProductBulkService, private readonly browse: AdminBrowseService, private readonly variantCopy: ProductVariantCopyService, private readonly variantDetach: ProductVariantDetachService) {}

  @Get("selection") async selectProducts(@Query() input: ProductSelectionDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return this.browse.productSelection(user, input);
  }

  @Post("bulk") async bulkUpdate(@Body() input: ProductBulkDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return this.bulk.apply(input, user.id);
  }

  @Post() create(@Body() input: ProductDto, @Req() request: AuthRequest) {
    return this.save(input, request);
  }

  @Post(":id/copy-to-variants") async copyToVariants(@Param("id") id: string, @Body() input: ProductVariantCopyDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return this.variantCopy.apply(id, input, user.id);
  }

  @Post(":id/detach-variant") async detachVariant(@Param("id") id: string, @Body() input: ProductVariantDetachDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return this.variantDetach.apply(id, input, user.id);
  }

  @Get(":id/variants") async variantGroup(@Param("id") id: string, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    const repository = this.db.source.getRepository(ProductEntity);
    const selected = await repository.findOneBy({ id });
    if (!selected) throw new NotFoundException("Không tìm thấy sản phẩm.");
    const groupId = selected.data.variantGroupId || id;
    const rows = await repository.createQueryBuilder("p")
      .where("p.id = :groupId OR p.data->>'variantGroupId' = :groupId", { groupId })
      .orderBy("p.createdAt", "ASC").addOrderBy("p.id", "ASC").getMany();
    if (!rows.some(row => row.id === groupId)) throw new NotFoundException("Không tìm thấy sản phẩm gốc của nhóm.");
    return { products: rows.map(row => ({ ...row.data, published: row.published, revision: row.revision })) };
  }

  @Patch(":id/variants") async configureVariants(@Param("id") id: string, @Body() input: ProductVariantGroupDto, @Req() request: AuthRequest) {
    const user = (await this.auth.authenticate(request))!;
    if (!["admin", "boss", "sales"].includes(user.role)) throw new ForbiddenException();
    return this.db.transaction(async manager => {
      const repository = manager.getRepository(ProductEntity);
      const root = await repository.createQueryBuilder("p").setLock("pessimistic_write").where("p.id = :id", { id }).getOne();
      if (!root) throw new NotFoundException("Không tìm thấy sản phẩm gốc.");
      if (root.data.variantGroupId && root.data.variantGroupId !== id) throw new BadRequestException("Thiết lập loại biến thể từ sản phẩm gốc của nhóm.");
      const rows = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .where("p.id = :id OR p.data->>'variantGroupId' = :id", { id }).getMany();
      const changes = new Map(input.products.map(product => [product.id, product]));
      if (rows.length !== changes.size || rows.some(row => !changes.has(row.id))) {
        throw new ConflictException("Danh sách SKU trong nhóm đã thay đổi. Tải lại trước khi lưu.");
      }
      if (rows.some(row => row.revision !== changes.get(row.id)!.revision)) {
        throw new ConflictException("Một SKU đã được cập nhật ở phiên khác. Tải lại trước khi lưu.");
      }
      const products: Product[] = rows.map(row => {
        const attributes = changes.get(row.id)!.attributes;
        return { ...row.data, variantGroupId: id, variantAttributes: attributes,
          size: variantDimension(attributes, "size") || row.data.size,
          color: variantDimension(attributes, "color") || row.data.color };
      });
      const anchor = products.find(product => product.id === id)!;
      const previous = rows.map(row => row.data);
      validateVariantGroupConfiguration(products, anchor, previous);
      const byId = new Map(products.map(product => [product.id, product]));
      for (const row of rows) row.data = byId.get(row.id)!;
      const saved = await repository.save(rows);
      await manager.getRepository(AuditEntity).save({ actorId: user.id, action: "product-variant-group-update", resourceId: id,
        detail: { attributes: anchor.variantAttributes!.map(attribute => attribute.name), products: saved.map(row => ({ id: row.id, revision: row.revision })) } });
      return { products: saved.map(row => ({ ...row.data, published: row.published, revision: row.revision })) };
    });
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
      const pricing = resolveProductPricing(input, previous?.data);
      // SKU/unit are identities used by stock, order snapshots and Kiot mappings.
      if (previous && (previous.data.code !== input.code || previous.data.unit !== input.unit)) {
        const hasOrder = await manager.getRepository(OrderEntity).createQueryBuilder("orders")
          .where("orders.data->'items' @> :item::jsonb", { item: JSON.stringify([{ productId: id }]) }).getExists();
        const hasStock = previous.data.stock > 0 || await manager.getRepository(InventoryEntity).existsBy({ productId: id });
        const hasLink = await manager.getRepository(IntegrationLinkEntity).existsBy({ kind: "product", localId: id });
        if (hasOrder || hasStock || hasLink) throw new ConflictException("Không đổi mã hàng hoặc đơn vị khi sản phẩm đã có đơn, sổ kho hoặc liên kết KiotViet.");
      }
      for (const url of input.gallery) {
        try { await assertProductImageExists(url); }
        catch { throw new BadRequestException("Ảnh không tồn tại trên backend. Vui lòng tải ảnh lại."); }
      }
      const { revision: _revision, published, ...fields } = input;
      const productId = previous?.id || randomUUID();
      const groupId = input.variantGroupId === "self" ? productId : input.variantGroupId ?? previous?.data.variantGroupId;
      const attributes = input.variantAttributes ?? previous?.data.variantAttributes;
      if (groupId && (!attributes || (previous?.data.variantGroupId && previous.data.variantGroupId !== groupId))) {
        throw new BadRequestException("Nhóm biến thể không hợp lệ hoặc không thể đổi nhóm đã tạo.");
      }
      if (!groupId && attributes?.length) throw new BadRequestException("Chọn nhóm sản phẩm trước khi thêm thuộc tính biến thể.");
      if (groupId) {
        // Group membership changes lock the anchor before its members.
        const anchor = await repository.createQueryBuilder("p").setLock("pessimistic_write").where("p.id = :groupId", { groupId }).getOne();
        const locked = groupId === productId ? anchor : previous
          ? await repository.createQueryBuilder("p").setLock("pessimistic_write").where("p.id = :productId", { productId }).getOne() : null;
        if (previous && locked?.revision !== input.revision) throw new ConflictException("Sản phẩm đã thay đổi. Làm mới trước khi lưu.");
        const root = anchor?.data;
        if (groupId !== productId && (!root || root.variantGroupId !== groupId)) throw new BadRequestException("Không tìm thấy sản phẩm gốc của nhóm biến thể.");
        if (root && (root.category !== input.category || root.brand !== input.brand || root.unit !== input.unit)) throw new BadRequestException("Biến thể cần cùng danh mục, thương hiệu và đơn vị tính với sản phẩm gốc.");
        const siblings = await repository.createQueryBuilder("p").where("p.data->>'variantGroupId' = :groupId", { groupId }).getMany();
        if (groupId === productId && siblings.length && ((previous?.data.variantAttributes?.length || 0) !== attributes!.length || previous?.data.variantAttributes?.some((item, index) => attributeKey(item.name) !== attributeKey(attributes![index]?.name || "")))) {
          throw new BadRequestException("Nhóm đã có biến thể. Hãy giữ nguyên tên và thứ tự thuộc tính.");
        }
        const group = siblings.map(row => row.data);
        validateVariantGroup(attributes!, groupId === productId ? undefined : root, group, productId, group);
      }
      const data: Product = { ...previous?.data, ...fields, ...pricing, id: productId, image: input.gallery[0] || "", stock: previous?.data.stock || 0,
        materialGroups: input.materialGroups !== undefined ? input.materialGroups : previous?.data.materialGroups,
        colorGroups: input.colorGroups !== undefined ? input.colorGroups : previous?.data.colorGroups,
        originGroups: input.originGroups !== undefined ? input.originGroups : previous?.data.originGroups,
        showAuthenticityLabel: input.showAuthenticityLabel ?? previous?.data.showAuthenticityLabel ?? true,
        variantLabel: input.variantLabel ?? previous?.data.variantLabel,
        ...(groupId ? { variantGroupId: groupId, variantAttributes: attributes,
          size: variantDimension(attributes!, "size") || input.size,
          color: variantDimension(attributes!, "color") || input.color } : {}) };
      if (published) assertPublishable(data);
      const row = await repository.save(repository.create({ ...previous, id: productId, slug: input.slug, published, data }));
      await manager.getRepository(AuditEntity).save({ actorId: user.id, action: previous ? "product-update" : "product-create", resourceId: row.id, detail: { published, code: data.code, revision: row.revision } });
      return { id: row.id, product: { ...data, published: row.published, revision: row.revision } };
    });
  }
}
