import type { CategoryEntity } from "../database/entities";
import type { Category } from "../types/domain.types";
import { categoryTrail } from "./category-tree";

// Keep the pre-management catalog order for legacy rows without a saved position.
const legacyOrder = [
  "phu-kien-bep",
  "led-tu-ke",
  "ray-truot",
  "ban-le",
  "tay-nam",
  "khoa",
  "phu-kien-tu-ao",
  "phu-kien-lap-dat",
];

export function categoryView(row: CategoryEntity): Category {
  const legacyIndex = legacyOrder.indexOf(row.slug);
  return {
    ...row.data,
    slug: row.slug,
    visible: row.data.visible !== false,
    sortOrder:
      row.data.sortOrder ?? (legacyIndex >= 0 ? legacyIndex * 10 : 1000),
    revision: row.revision,
  };
}

export function orderedCategories(
  rows: CategoryEntity[],
  publicOnly = false,
): Category[] {
  const categories = rows.map(categoryView);
  return categories
    .filter((category) => {
      if (!publicOnly) return true;
      const trail = categoryTrail(categories, category.slug);
      return trail.length > 0 && trail.every(ancestor => ancestor.visible !== false);
    })
    .sort(
      (a, b) => a.sortOrder! - b.sortOrder! || a.slug.localeCompare(b.slug),
    );
}
