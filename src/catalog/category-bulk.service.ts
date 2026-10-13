import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { In } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { AuditEntity, CategoryEntity } from "../database/entities";
import { assertProductImageExists } from "../media/product-media";
import { CategoryBulkDto } from "./category-bulk.dto";

@Injectable()
export class CategoryBulkService {
  constructor(private readonly db: DatabaseService) {}

  async apply(input: CategoryBulkDto, actorId: string) {
    return this.db.transaction(async manager => {
      const repository = manager.getRepository(CategoryEntity);
      const rows = await repository.findBy({ slug: In(input.categories.map(category => category.slug)) });
      if (rows.length !== input.categories.length) throw new NotFoundException("Một số danh mục không còn tồn tại. Làm mới danh sách trước khi cập nhật.");
      const revisions = new Map(input.categories.map(category => [category.slug, category.revision]));
      const stale = rows.filter(row => row.revision !== revisions.get(row.slug));
      if (stale.length) throw new ConflictException(`Danh mục đã thay đổi: ${stale.slice(0, 5).map(row => row.data.name).join(", ")}. Làm mới và chọn lại trước khi cập nhật.`);
      const visible = input.action === "show";
      if (visible) {
        const invalid: string[] = [];
        for (const row of rows) {
          try {
            if (!row.data.image || !/^\/(?:images|media\/(?:images|uploads))\/[a-zA-Z0-9/_-]+\.(?:jpe?g|png|webp)$/.test(row.data.image)) throw new Error("Invalid category image.");
            await assertProductImageExists(row.data.image);
          } catch { invalid.push(row.data.name); }
        }
        if (invalid.length) throw new BadRequestException(`Chưa thể hiển thị ${invalid.length} danh mục thiếu ảnh đại diện hợp lệ: ${invalid.slice(0, 8).join(", ")}. Chưa cập nhật danh mục nào.`);
      }
      // Only visibility changes; product publication and category content stay intact.
      for (const row of rows) row.data = { ...row.data, visible };
      const saved = await repository.save(rows);
      const categories = saved.map(row => ({ slug: row.slug, revision: row.revision, visible }));
      await manager.getRepository(AuditEntity).save({ actorId, action: `categories-bulk-${input.action}`, resourceId: "categories", detail: { categories } });
      return { updated: saved.length, visible, categories };
    });
  }
}
