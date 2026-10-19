import { MATERIAL_GROUPS, materialGroups } from "./material-groups";

export const COLOR_GROUPS = [
  { value: "black", label: "Đen" },
  { value: "white", label: "Trắng" },
  { value: "gray", label: "Xám / Ghi" },
  { value: "silver", label: "Bạc / Inox / Crôm" },
  { value: "gold", label: "Vàng / Champagne" },
  { value: "copper", label: "Đồng" },
  { value: "brown", label: "Nâu" },
  { value: "beige", label: "Be / Kem" },
  { value: "red", label: "Đỏ" },
  { value: "blue", label: "Xanh dương" },
  { value: "green", label: "Xanh lá" },
  { value: "transparent", label: "Trong suốt" },
  { value: "other", label: "Màu khác" },
] as const;

export const ORIGIN_GROUPS = [
  { value: "vietnam", label: "Việt Nam" },
  { value: "china", label: "Trung Quốc" },
  { value: "germany", label: "Đức" },
  { value: "malaysia", label: "Malaysia" },
  { value: "thailand", label: "Thái Lan" },
  { value: "italy", label: "Ý" },
  { value: "spain", label: "Tây Ban Nha" },
  { value: "japan", label: "Nhật Bản" },
  { value: "korea", label: "Hàn Quốc" },
  { value: "taiwan", label: "Đài Loan" },
  { value: "india", label: "Ấn Độ" },
  { value: "indonesia", label: "Indonesia" },
  { value: "poland", label: "Ba Lan" },
  { value: "austria", label: "Áo" },
  { value: "france", label: "Pháp" },
  { value: "turkey", label: "Thổ Nhĩ Kỳ" },
  { value: "other", label: "Xuất xứ khác" },
] as const;

export const PRODUCT_FACET_FIELDS = ["material", "color", "origin"] as const;
export type ProductFacetField = typeof PRODUCT_FACET_FIELDS[number];
export const PRODUCT_FACETS = {
  material: { label: "Chất liệu", selectionField: "materialGroups", queryField: "materialGroup", options: MATERIAL_GROUPS },
  color: { label: "Màu sắc", selectionField: "colorGroups", queryField: "colorGroup", options: COLOR_GROUPS },
  origin: { label: "Xuất xứ", selectionField: "originGroups", queryField: "originGroup", options: ORIGIN_GROUPS },
} as const;
export type ProductFacetQuery = typeof PRODUCT_FACETS[ProductFacetField]["queryField"];
export type ProductFacetSelections = { materialGroups?: string[] | null; colorGroups?: string[] | null; originGroups?: string[] | null };
export type ProductFacetData = Partial<Record<ProductFacetField, string>> & ProductFacetSelections;

const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/\s+/g, " ").trim();
const colorPatterns: Record<Exclude<typeof COLOR_GROUPS[number]["value"], "other">, RegExp> = {
  black: /\b(?:den|black)\b/,
  white: /\b(?:trang|white)\b/,
  gray: /\b(?:xam|ghi|gray|grey|anthracite)\b/,
  silver: /\b(?:bac|inox|silver|chrome?|crom|stainless)\b/,
  gold: /\b(?:vang|gold|champagne)\b/,
  copper: /\b(?:dong|copper|bronze|brass)\b/,
  brown: /\b(?:nau|brown)\b/,
  beige: /\b(?:be|kem|beige|cream)\b/,
  red: /\b(?:do|red)\b/,
  blue: /\bxanh (?:duong|da troi|nuoc bien)\b|\bblue\b/,
  green: /\bxanh (?:la(?: cay)?|luc)\b|\bgreen\b/,
  transparent: /\btrong suot\b|\b(?:clear|transparent)\b/,
};
const originPatterns: Record<Exclude<typeof ORIGIN_GROUPS[number]["value"], "other">, RegExp> = {
  vietnam: /\bviet\s?nam\b|^vn$/,
  china: /\btrung quoc\b|\b(?:china|prc|p\.r\.c)\b/,
  germany: /\b(?:duc|germany|german|deutschland)\b/,
  malaysia: /\bmalaysia\b/,
  thailand: /\bthai lan\b|\bthailand\b/,
  italy: /\b(?:y|italy|italia)\b/,
  spain: /\btay ban nha\b|\b(?:spain|espana)\b/,
  japan: /\bnhat(?: ban)?\b|\bjapan\b/,
  korea: /\bhan quoc\b|\b(?:south )?korea\b/,
  taiwan: /\bdai loan\b|\btaiwan\b/,
  india: /\ban do\b|\bindia\b/,
  indonesia: /\bindonesia\b/,
  poland: /\bba lan\b|\bpoland\b/,
  austria: /\bao\b|\baustria\b/,
  france: /\bphap\b|\bfrance\b/,
  turkey: /\btho nhi ky\b|\b(?:turkey|turkiye)\b/,
};

export function inferredFacetGroups(field: ProductFacetField, value: string): string[] {
  if (field === "material") return materialGroups(value);
  const text = normalized(value);
  if (!text) return [];
  // A manufacturer's location takes priority over a design/brand country.
  const origin = text.match(/(?:san xuat(?: tai)?|made in|xuat xu)\s*:?\s*(.*)/)?.[1] || text;
  const groups = field === "color"
    ? COLOR_GROUPS.filter(option => option.value !== "other" && colorPatterns[option.value].test(text))
    : ORIGIN_GROUPS.filter(option => option.value !== "other" && originPatterns[option.value].test(origin));
  return groups.length ? groups.map(option => option.value) : ["other"];
}

// Missing/null selections infer from legacy descriptions. An explicit empty
// array means the administrator intentionally left this facet unclassified.
export function productFacetGroups(product: ProductFacetData, field: ProductFacetField): string[] {
  const definition = PRODUCT_FACETS[field];
  const selected = product[definition.selectionField];
  if (!Array.isArray(selected)) return inferredFacetGroups(field, product[field] || "");
  return definition.options.filter(option => selected.includes(option.value)).map(option => option.value);
}

export function matchesProductFacet(product: ProductFacetData, field: ProductFacetField, selected: readonly string[]): boolean {
  return !selected.length || productFacetGroups(product, field).some(value => selected.includes(value));
}

export function availableFacetGroups(field: ProductFacetField, values: readonly string[], selected: readonly string[] = [], publishedGroups?: readonly string[]) {
  const present = new Set([...(publishedGroups ?? values.flatMap(value => inferredFacetGroups(field, value))), ...selected]);
  return PRODUCT_FACETS[field].options.filter(option => present.has(option.value));
}
