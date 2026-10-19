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

export function sentenceCaseCategoryName(name: string): string {
  const lower = name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
  return lower.charAt(0).toLocaleUpperCase("vi") + lower.slice(1);
}

export function categoryIdentityConflict(categories: Category[], candidate: Pick<Category, "slug" | "name" | "parentSlug">, previousSlug?: string): boolean {
  const nameKey = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
  return categories.some(category => category.slug !== previousSlug && (category.slug === candidate.slug ||
    ((category.parentSlug || "") === (candidate.parentSlug || "") && nameKey(category.name) === nameKey(candidate.name))));
}

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
