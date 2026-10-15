import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, ProductEntity } from "../database/entities";
import { ProductVariantDetachDto } from "./product-variant-detach.dto";

@Injectable()
export class ProductVariantDetachService {
  constructor(private readonly db: DatabaseService) {}

  async apply(id: string, input: ProductVariantDetachDto, actorId: string) {
    return this.db.transaction(async manager => {
      const repository = manager.getRepository(ProductEntity);
      const root = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .where("p.id = :groupId", { groupId: input.groupId }).getOne();
      if (!root) throw new NotFoundException("Không tìm thấy sản phẩm gốc của nhóm.");
      if (root.data.variantGroupId !== input.groupId) throw new ConflictException("Nhóm biến thể đã thay đổi. Tải lại trước khi tách SKU.");
      const rows = await repository.createQueryBuilder("p").setLock("pessimistic_write")
        .where("p.data->>'variantGroupId' = :groupId", { groupId: input.groupId })
        .orderBy("p.createdAt", "ASC").addOrderBy("p.id", "ASC").getMany();
      const revisions = new Map(input.products.map(product => [product.id, product.revision]));
      if (rows.length < 2 || rows.length !== revisions.size || rows.some(row => !revisions.has(row.id))) {
        throw new ConflictException("Danh sách SKU trong nhóm đã thay đổi. Tải lại trước khi tách SKU.");
      }
      if (rows.some(row => row.revision !== revisions.get(row.id))) {
        throw new ConflictException("Một SKU đã được cập nhật ở phiên khác. Tải lại trước khi tách SKU.");
      }
      const selected = rows.find(row => row.id === id);
      if (!selected) throw new ConflictException("SKU không còn thuộc nhóm này. Tải lại trước khi tách.");
      const remaining = rows.filter(row => row.id !== id);
      const groupId = id === input.groupId ? remaining[0].id : input.groupId;
      // An isolated group retains the SKU's own attributes and custom label.
      // No identity, content, inventory or order references are removed.
      selected.data = { ...selected.data, variantGroupId: selected.id };
      // Detaching the anchor changes membership even though its own group ID stays the same.
      selected.revision += 1;
      const changes = [selected];
      if (groupId !== input.groupId) {
        for (const row of remaining) {
          row.data = { ...row.data, variantGroupId: groupId };
          changes.push(row);
        }
      }
      const saved = await repository.save(changes);
      await manager.getRepository(AuditEntity).save({ actorId, action: "product-variant-detach", resourceId: id,
        detail: { previousGroupId: input.groupId, remainingGroupId: groupId, products: saved.map(row => ({ id: row.id, revision: row.revision })) } });
      return { id, groupId, products: rows.map(row => {
        const product = saved.find(product => product.id === row.id) || row;
        return { ...product.data, published: product.published, revision: product.revision };
      }) };
    });
  }
}
