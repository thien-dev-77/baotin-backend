import type { Category, Product } from "../types/domain.types";
import { assertCategoryTree, categoryDescendants } from "./category-tree";

export const FULCO_TAXONOMY_VERSION = "fulco-category-tree-v1";
const kitchen = "phu-kien-tu-bep";
const upper = "phu-kien-tu-bep-tren";
const lower = "phu-kien-tu-bep-duoi";
const pots = "gia-xoong-noi-bat-dia-da-nang";
const spices = "gia-dao-thot-chai-lo-da-nang";
const corner = "gia-ke-tu-goc";
const waste = "thung-gao-thung-rac";
const wood = "phu-kien-noi-that";
const wardrobe = "phu-kien-tu-quan-ao";
const sinks = "chau-voi-rua-bat";
const appliances = "thiet-bi-bep-gia-dung";

type Definition = { slug: string; name: string; parentSlug: string; existing?: boolean };
const node = (slug: string, name: string, parentSlug = "", existing = false): Definition => ({ slug, name, parentSlug, existing });
// Existing slugs remain stable, including the detailed material groups imported from Excel.
export const FULCO_CATEGORIES: readonly Definition[] = [
  node(sinks, "Hệ thống chậu - Vòi rửa", "", true),
  node("voi-rua", "Vòi rửa", sinks),
  node("chau-rua", "Chậu rửa", sinks),
  node(wood, "Phụ kiện mộc nội thất", "", true),
  node("phu-kien-khac", "Phụ kiện khác", wood),
  node("piston-hoi-thuy-luc", "Piston hơi & thủy lực", wood),
  node("he-thong-tay-nang", "Hệ thống tay nâng", wood),
  node("ray-truot", "Ray trượt", wood),
  node("ban-le", "Bản lề", wood),
  node(wardrobe, "Phụ kiện tủ quần áo", "", true),
  node("gia-de-giay", "Giá để giày", wardrobe),
  node("ngan-keo-de-do", "Ngăn kéo để đồ", wardrobe),
  node("gia-treo-quan-au-cao-cap", "Giá treo quần âu cao cấp", wardrobe),
  node("gia-nang-ha-co-treo-quan-ao", "Giá nâng hạ cơ treo quần áo", wardrobe),
  node(kitchen, "Phụ kiện tủ bếp"),
  node(corner, "Hệ thống phụ kiện góc", kitchen, true),
  node("mam-xoay-tu-goc-inox-304-bao-hanh-vinh-vien", "Mâm xoay tủ góc", corner, true),
  node("tu-do-kho-tu-kho-inox-304-bao-hanh-vinh-vien", "Tủ đồ khô - Tủ kho", kitchen, true),
  node(waste, "Thùng gạo - Thùng rác", kitchen),
  node("thung-gao", "Thùng gạo", waste, true),
  node("thung-rac", "Thùng rác", waste, true),
  node(lower, "Phụ kiện tủ bếp dưới", kitchen),
  node(spices, "Giá đựng chất tẩy rửa & gia vị", lower, true),
  node("gia-dao-thot-chai-lo-da-nang-inox-304-nan-det-bao-hanh-vinh-vien", "Giá dao thớt, chai lọ inox 304 nan dẹt", spices, true),
  node("gia-dao-thot-chai-lo-da-nang-inox-304-nan-oval-bao-hanh-vinh-vien", "Giá dao thớt, chai lọ inox 304 nan oval", spices, true),
  node("gia-dao-thot-chai-lo-da-nang-inox-304-nan-tron-bao-hanh-vinh-vien", "Giá dao thớt, chai lọ inox 304 nan tròn", spices, true),
  node("gia-chai-lo-gia-vi-da-nang-inox-304-nan-det-bao-hanh-vinh-vien", "Giá chai lọ, gia vị inox 304 nan dẹt", spices, true),
  node("gia-dung-chai-lo-tay-rua-day-dac", "Giá đựng chai lọ, chất tẩy rửa", spices, true),
  node(pots, "Giá bát đĩa - Xoong nồi", lower, true),
  node("gia-ke-xoong-noi-bat-dia-inox-304-nan-tron-bao-hanh-vinh-vien", "Giá bát đĩa, xoong nồi inox 304 nan tròn", pots, true),
  node("gia-ke-xoong-noi-bat-dia-inox-304-nan-oval-bao-hanh-vinh-vien", "Giá bát đĩa, xoong nồi inox 304 nan oval", pots, true),
  node("gia-ke-xoong-noi-bat-dia-inox-304-nan-det-bao-hanh-vinh-vien", "Giá bát đĩa, xoong nồi inox 304 nan dẹt", pots, true),
  node("gia-ke-xoong-noi-bat-dia-inox-304-xuoc-mo-bao-hanh-vinh-vien", "Giá bát đĩa, xoong nồi inox 304 xước mờ", pots, true),
  node("khay-chia-thia-dia-nhua-carbon", "Khay chia thìa - Dĩa", lower, true),
  node(upper, "Phụ kiện tủ bếp trên", kitchen),
  node("gia-bat-dia-co-dinh-tu-tren", "Giá bát cố định", upper, true),
  node("gia-nang-ha-co-dieu-chinh-luc", "Giá nâng hạ", upper, true),
  node("gia-bat-dia-nang-ha-dien", "Giá nâng hạ điện", upper, true),
  node(appliances, "Thiết bị bếp & Đồ gia dụng", "", true),
  node("bo-noi-chao-inox-304-bao-hanh-vinh-vien", "Xoong & Nồi", appliances, true),
  node("noi-com-dien", "Nồi cơm điện", appliances),
  node("may-rua-bat-cam-ung-cao-cap-bao-hanh-3-nam", "Máy rửa bát", appliances, true),
  node("thiet-bi-hut-mui-bao-hanh-3-nam", "Máy hút mùi", appliances, true),
  node("thiet-bi-bep-tu-bao-hanh-5-nam", "Bếp từ", appliances, true),
];

type CategoryRow = { slug: string; data: Category; revision: number };
type ProductRow = { id: string; data: Product; published: boolean; revision: number };
const faucetCodes = new Set(["F11", "F22", "F33", "F44", "F55", "F66", "F77", "F88", "F99", "NS-J688", "NS-J699"]);
const wardrobePrefixes: readonly [string, string][] = [
  ["FCH201A-", "gia-treo-quan-au-cao-cap"], ["FCH303-", "gia-treo-quan-au-cao-cap"],
  ["FCH203-", "ngan-keo-de-do"], ["FCH205-", "ngan-keo-de-do"],
  ["FCH207B-", "gia-de-giay"], ["FCH403-", "gia-de-giay"],
  ["FCH614-WD-", "gia-nang-ha-co-treo-quan-ao"],
];

function targetCategory(product: Product): string {
  if (product.category === sinks) {
    if (faucetCodes.has(product.code)) return "voi-rua";
    if (/^(FC-[BDHKPSTUV]|NS-JP)/.test(product.code)) return "chau-rua";
    throw new Error(`Chưa phân loại được chậu/vòi: ${product.code}.`);
  }
  if (product.category === wardrobe) {
    const target = wardrobePrefixes.find(([prefix]) => product.code.startsWith(prefix));
    if (target) return target[1];
    throw new Error(`Chưa phân loại được phụ kiện tủ áo: ${product.code}.`);
  }
  if (product.category === wood) {
    if (["FC225", "FC228"].includes(product.code)) return "he-thong-tay-nang";
    throw new Error(`Chưa phân loại được phụ kiện mộc: ${product.code}.`);
  }
  if (product.category === appliances) {
    if (["FC-50EC12T", "FC-70NC18P-T", "FC-70NC18P-X"].includes(product.code)) return "noi-com-dien";
    if (product.code === "FC115") return "bo-noi-chao-inox-304-bao-hanh-vinh-vien";
    if (["FC99", "FC996"].includes(product.code)) return "thiet-bi-bep-tu-bao-hanh-5-nam";
    throw new Error(`Chưa phân loại được đồ gia dụng: ${product.code}.`);
  }
  return product.category;
}

export function planFulcoTaxonomy(categoryRows: readonly CategoryRow[], productRows: readonly ProductRow[]) {
  const current = new Map(categoryRows.map(row => [row.slug, row]));
  const missing = FULCO_CATEGORIES.filter(definition => definition.existing && !current.has(definition.slug));
  if (missing.length) throw new Error(`Thiếu danh mục Fulco gốc: ${missing.map(item => item.slug).join(", ")}. Không cập nhật.`);
  const assignments = productRows.map(row => ({ id: row.id, code: row.data.code, from: row.data.category, to: targetCategory(row.data), revision: row.revision }));
  const assignmentsById = new Map(assignments.map(item => [item.id, item]));
  const tree = FULCO_CATEGORIES.map(definition => ({ ...definition }));
  const counts = new Map<string, number>();
  for (const assignment of assignments) counts.set(assignment.to, (counts.get(assignment.to) || 0) + 1);
  const planned = tree.map((definition, index): Category => {
    const previous = current.get(definition.slug)?.data;
    const descendants = new Set(categoryDescendants(tree, definition.slug));
    const sample = productRows.find(row => row.published && descendants.has(assignmentsById.get(row.id)!.to) && row.data.image) || productRows.find(row => descendants.has(assignmentsById.get(row.id)!.to) && row.data.image);
    const image = previous?.image || sample?.data.image || "";
    const hasProducts = Array.from(descendants).some(slug => counts.has(slug));
    return { ...previous, slug: definition.slug, name: definition.name, parentSlug: definition.parentSlug, image, description: previous?.description || "", subcategories: previous?.subcategories || [], sortOrder: index * 10, visible: previous ? previous.visible !== false : hasProducts && !!image };
  });
  const plannedSlugs = new Set(planned.map(category => category.slug));
  const all = [...categoryRows.filter(row => !plannedSlugs.has(row.slug)).map(row => ({ ...row.data, slug: row.slug })), ...planned];
  assertCategoryTree(all);
  const names = all.map(category => category.name.normalize("NFC").trim().toLocaleLowerCase("vi"));
  if (new Set(names).size !== names.length) throw new Error("Tên danh mục chuẩn hóa trùng với danh mục khác. Không cập nhật.");
  for (const assignment of assignments) if (!all.some(category => category.slug === assignment.to)) throw new Error(`Danh mục không tồn tại cho ${assignment.code}.`);
  const groupCategories = new Map<string, string>();
  for (const row of productRows) {
    if (!row.data.variantGroupId) continue;
    const target = assignmentsById.get(row.id)!.to;
    const previous = groupCategories.get(row.data.variantGroupId);
    if (previous && previous !== target) throw new Error(`Nhóm biến thể ${row.data.variantGroupId} bị tách danh mục. Không cập nhật.`);
    groupCategories.set(row.data.variantGroupId, target);
  }
  const categories = planned.filter(category => {
    const previous = current.get(category.slug)?.data;
    return !previous || ["name", "parentSlug", "image", "sortOrder", "visible"].some(key => previous[key as keyof Category] !== category[key as keyof Category]);
  }).map(data => ({ slug: data.slug, data, revision: current.get(data.slug)?.revision || 0 }));
  return { categories, products: assignments.filter(item => item.from !== item.to), tree: all,
    summary: { roots: all.filter(category => !category.parentSlug).length, categoriesBefore: categoryRows.length, categoriesAfter: all.length, added: planned.filter(category => !current.has(category.slug)).length, categoriesUpdated: categories.filter(row => row.revision > 0).length, productsReassigned: assignments.filter(item => item.from !== item.to).length, productsTotal: productRows.length, published: productRows.filter(row => row.published).length, private: productRows.filter(row => !row.published).length } };
}
