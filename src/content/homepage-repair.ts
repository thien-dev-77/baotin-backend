import type { ContentEntity } from "../database/experience.entities";
import type { CategoryEntity, ProductEntity } from "../database/entities";
import { categoryTrail } from "../catalog/category-tree";
import { assertPublishable } from "../catalog/product.rules";

export const HOMEPAGE_REPAIR_VERSION = "fulco-homepage-v1";
export const HOMEPAGE_FEATURED_CODES = [
  "FC36S-600-304", "NSP-00179", "FC202", "FC-D7546-304", "F66",
  "FC225", "FCH201A-700", "FCH614-WD-600", "FC-ML638i", "FC589",
] as const;
const bannerTargets = [
  { id: "banner:banner-1", oldCategory: "phu-kien-bep", image: "/images/hero/kitchen-lighting-hd.jpg", category: "phu-kien-tu-bep", title: "Phụ kiện tủ bếp" },
  { id: "banner:banner-2", oldCategory: "led-tu-ke", image: "/images/hero/cabinet-lighting-hd.jpg", category: "phu-kien-tu-bep-duoi", title: "Phụ kiện tủ bếp dưới" },
  { id: "banner:banner-3", oldCategory: "phu-kien-lap-dat", image: "/images/hero/wood-kitchen-hd.jpg", category: "phu-kien-tu-bep-tren", title: "Phụ kiện tủ bếp trên" },
] as const;

export function planHomepageRepair(content: ContentEntity[], products: ProductEntity[], categories: CategoryEntity[]) {
  const tree = categories.map(row => ({ ...row.data, slug: row.slug }));
  const banners: ContentEntity[] = [];
  for (const target of bannerTargets) {
    const row = content.find(row => row.id === target.id);
    if (!row || row.published) continue;
    // Restore only untouched, cleanup-disabled fixture banners; never replace authored drafts.
    if (row.kind !== "banner" || row.revision !== 2 || row.data.category !== target.oldCategory || row.data.href !== `/category/${target.oldCategory}` || row.data.image !== target.image) continue;
    const trail = categoryTrail(tree, target.category);
    if (!trail.length || trail.some(category => category.visible === false)) throw new Error(`Banner target category is unavailable: ${target.category}.`);
    banners.push({ ...row, published: true, data: { ...row.data, category: target.category, href: `/category/${target.category}`, title: target.title } });
  }
  const featured: ProductEntity[] = [];
  const selected: ProductEntity[] = [];
  for (const code of HOMEPAGE_FEATURED_CODES) {
    const matches = products.filter(row => row.data.code === code);
    if (matches.length !== 1) throw new Error(`Expected one catalog product for featured code: ${code}.`);
    const requested = matches[0];
    const row = products.find(row => row.published && row.id === requested.data.variantGroupId) || requested;
    const trail = categoryTrail(tree, row.data.category);
    if (!row.published || !trail.length || trail.some(category => category.visible === false)) throw new Error(`Featured product is private or in a hidden category: ${code}.`);
    assertPublishable(row.data);
    selected.push(row);
    if (!row.data.featured) featured.push(row);
  }
  if (new Set(selected.map(row => row.data.variantGroupId || row.id)).size !== selected.length) throw new Error("Featured selection contains duplicate variant families.");
  return { banners, featured, selected: selected.map(row => ({ id: row.id, code: row.data.code, name: row.data.name })),
    summary: { bannersRestored: banners.length, productsFeatured: featured.length, selectedProducts: selected.length } };
}
