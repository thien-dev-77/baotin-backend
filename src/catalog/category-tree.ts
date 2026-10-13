import { BadRequestException } from "@nestjs/common";
import type { Category } from "../types/domain.types";

export const MAX_CATEGORY_DEPTH = 4;

export function categoryTrail(categories: readonly Category[], slug: string): Category[] {
  const bySlug = new Map(categories.map(category => [category.slug, category]));
  const trail: Category[] = [];
  const seen = new Set<string>();
  let current = bySlug.get(slug);
  while (current) {
    if (seen.has(current.slug)) return [];
    seen.add(current.slug); trail.unshift(current);
    if (!current.parentSlug) return trail;
    current = bySlug.get(current.parentSlug);
  }
  return [];
}

export function categoryDescendants(categories: readonly Pick<Category, "slug" | "parentSlug">[], slug: string): string[] {
  const result = new Set([slug]);
  const pending = [slug];
  for (let index = 0; index < pending.length; index++) {
    for (const category of categories) {
      if (category.parentSlug !== pending[index] || result.has(category.slug)) continue;
      result.add(category.slug); pending.push(category.slug);
    }
  }
  return [...result];
}

export function assertCategoryTree(categories: readonly Category[]) {
  for (const category of categories) {
    const trail = categoryTrail(categories, category.slug);
    if (!trail.length) throw new BadRequestException("Danh mục cha không tồn tại hoặc tạo vòng lặp. Chọn lại danh mục cha.");
    if (trail.length > MAX_CATEGORY_DEPTH) throw new BadRequestException(`Danh mục hỗ trợ tối đa ${MAX_CATEGORY_DEPTH} cấp. Chọn danh mục cha ở cấp cao hơn.`);
  }
}
