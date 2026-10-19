export const MATERIAL_GROUPS = [
  { value: "inox-304", label: "Inox 304" },
  { value: "inox-other", label: "Inox khác / chưa rõ" },
  { value: "steel", label: "Thép" },
  { value: "aluminum", label: "Nhôm" },
  { value: "plastic", label: "Nhựa" },
  { value: "copper", label: "Đồng / Đồng thau" },
  { value: "alloy", label: "Hợp kim" },
  { value: "glass", label: "Kính / Gốm kính" },
  { value: "stone", label: "Đá / Granite" },
  { value: "rubber", label: "Cao su / Silicone" },
  { value: "wood", label: "Gỗ" },
  { value: "ceramic", label: "Gốm / Sứ" },
  { value: "other", label: "Chất liệu khác" },
] as const;

export type MaterialGroup = typeof MATERIAL_GROUPS[number]["value"];
export const MATERIAL_GROUP_VALUES = MATERIAL_GROUPS.map(group => group.value);

const normalizeMaterial = (value: string) => value.normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase()
  .replace(/\s+/g, " ").trim();

// These are navigation tags only. Never replace the product's material text.
// Compound descriptions can belong to several groups; an unspecified inox
// grade is kept separate from an explicit 304 grade.
export function materialGroups(value: string): MaterialGroup[] {
  const text = normalizeMaterial(value);
  if (!text) return [];
  const groups: MaterialGroup[] = [];
  const grade304 = /\b(?:inox|sus|aisi|ss|thep khong (?:gi|ri)|stainless(?: steel)?)\s*[-/]?\s*304\b/.test(text);
  const stainless = grade304 || /\b(?:inox(?:\s*[-/]?\s*\d{3})?|sus\s*[-/]?\s*\d{3}|aisi\s*\d{3}|ss\s*\d{3}|thep khong (?:gi|ri)|stainless(?: steel)?)\b/.test(text);
  if (grade304) groups.push("inox-304");
  if (stainless && !grade304) groups.push("inox-other");
  const ordinarySteel = text.replace(/\bthep khong (?:gi|ri)\b|\bstainless(?: steel)?\b/g, " ");
  if (/\b(?:thep|sat|steel)\b/.test(ordinarySteel)) groups.push("steel");
  if (/\b(?:nhom|aluminium|aluminum)\b/.test(text)) groups.push("aluminum");
  if (/\b(?:nhua|abs|pvc|polyamid|polyamide|polymer|nylon|tpe|pom|polypropylene|polyethylene)\b/.test(text)) groups.push("plastic");
  if (/\b(?:dong|brass|copper)\b/.test(text)) groups.push("copper");
  if (/\bhop kim\b|\bzamak\b|\bzinc\b|^kem$/.test(text)) groups.push("alloy");
  if (/\b(?:kinh|thuy tinh|ceran|glass)\b/.test(text)) groups.push("glass");
  if (/^da$|\b(?:da (?:granite|nhan tao|tu nhien)|granite|marble|stone)\b/.test(text)) groups.push("stone");
  if (/\bcao su\b|\b(?:silicone?|rubber|elastomer)\b/.test(text)) groups.push("rubber");
  if (/\b(?:go|wood|mdf|hdf)\b/.test(text)) groups.push("wood");
  const ceramic = text.replace(/\bgom thuy tinh\b|\bcao su\b/g, " ");
  if (/\b(?:gom|su|ceramic|porcelain)\b/.test(ceramic)) groups.push("ceramic");
  return groups.length ? groups : ["other"];
}

export function matchesMaterialGroups(value: string, selected: readonly string[]): boolean {
  return !selected.length || materialGroups(value).some(group => selected.includes(group));
}

export function availableMaterialGroups(values: readonly string[], selected: readonly string[] = []) {
  const present = new Set([...values.flatMap(materialGroups), ...selected]);
  return MATERIAL_GROUPS.filter(group => present.has(group.value));
}
