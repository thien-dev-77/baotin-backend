import ExcelJS from "exceljs";
import { createHash, randomUUID } from "node:crypto";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import type { Category, Product } from "../types/domain.types";
import { CategoryDto } from "./category.dto";
import { ProductDto, productImagePattern } from "./product.dto";
import { MAX_PRODUCT_GALLERY } from "./product.constants";
import { MAX_PRODUCT_PRICE, resolveProductPricing } from "./product-pricing";
import { assertCategoryTree, categoryTrail } from "./category-tree";
import { validateVariantGroupConfiguration } from "./product-variants";
import { importSlug } from "./fulco-import";
import { sentenceCaseCategoryName } from "./category.rules";

export const HAFELE_BRAND = "HAFELE";
export const HAFELE_IMPORT_VERSION = "hafele-import-v1";
export const HAFELE_HEADERS = ["STT", "Nhóm sản phẩm", "Mã sản phẩm", "Mã SP mới / MasterSKU", "Tên sản phẩm (Web mẫu)", "Link sản phẩm mẫu", "Gallery (Link ảnh)", "Nội dung ngắn (Web)", "Thông tin sản phẩm (Web)", "Thông số kỹ thuật (Web)", "Hướng dẫn sử dụng (Web)", "Mô tả Sản phẩm & Quy cách", "ĐVT", "Khoang tủ", "Kích thước", "Giá niêm yết (VNĐ)", "Chiết khấu B2C", "Giá sau CK B2C (VNĐ)", "Chiết khấu B2B", "Giá sau CK B2B (VNĐ)"];
const HEADER_ROW = 4;
const CATEGORY_SLUG_LIMIT = 80;
const SLUG_HASH_LENGTH = 8;
const PRODUCT_SLUG_LIMIT = 200;
const SUMMARY_LIMIT = 500;
const key = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
const joined = (values: string[], separator = "\n\n") => [...new Set(values.filter(Boolean))].join(separator);

export type HafeleWarning = { row: number; code: string; messages: string[] };
export type HafeleRow = {
  row: number; family: string; stt: string; code: string; masterSku: string; name: string;
  categoryPath: string[]; sourceUrl: string; gallery: string[]; shortDescription: string;
  information: string; technicalDetails: string; usageGuide: string; packaging: string;
  unit: string; cabinet: string; dimensions: string; listPrice: number; rawListPrice: string;
  missingPrice: boolean; b2cDiscount: number; b2bDiscount: number;
};
export type HafeleWorkbook = { sheet: string; hash: string; rows: HafeleRow[]; warnings: HafeleWarning[] };
export type HafeleCategoryRow = { slug: string; data: Category; revision: number };
export type HafeleImportPlan = {
  version: string; workbookHash: string; sourceRows: number; categories: Category[];
  reusedCategorySlugs: string[]; categoryMappings: { path: string[]; slug: string; reused: boolean }[];
  products: { data: Product; published: false; sourceRows: number[]; sourcePaths: string[][]; masterSkus: string[] }[];
  warnings: HafeleWarning[]; variantGroups: number;
};

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).normalize("NFC").trim();
  if (typeof value === "object" && "hyperlink" in value) return value.hyperlink.trim();
  if (typeof value === "object" && "richText" in value) return value.richText.map(part => part.text).join("").normalize("NFC").trim();
  throw new Error(`Ô ${cell.address} phải chứa dữ liệu gốc, không phải công thức.`);
}

function percent(cell: ExcelJS.Cell): number {
  const number = Number(cellText(cell));
  if (!cellText(cell) || !Number.isFinite(number) || number < 0 || number >= 1) throw new Error(`Chiết khấu không hợp lệ tại ${cell.address}.`);
  return Math.round(number * 10_000) / 100;
}

export async function parseHafeleWorkbook(bytes: Buffer): Promise<HafeleWorkbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error("Workbook không có sheet dữ liệu.");
  HAFELE_HEADERS.forEach((header, index) => {
    if (key(cellText(sheet.getCell(HEADER_ROW, index + 1))) !== key(header)) throw new Error(`Sai tiêu đề cột ${index + 1}; cần ${header}.`);
  });
  const rows: HafeleRow[] = [], warnings: HafeleWarning[] = [];
  for (let index = HEADER_ROW + 1; index <= sheet.rowCount; index++) {
    const text = (column: number) => cellText(sheet.getCell(index, column));
    const code = text(3);
    if (!code) continue;
    const categoryPath = text(2).split("|").map(part => part.trim().replace(/\s+/g, " "));
    if (categoryPath.some(part => !part) || categoryPath.length > 4 || !text(5) || !text(13)) throw new Error(`Thiếu danh mục/tên/đơn vị tại dòng ${index}.`);
    if (text(14) && !/^\d+(?:-\d+)?$/.test(text(14))) throw new Error(`Khoang tủ N${index} phải là số hoặc khoảng số; chuyển kích thước/kiểu lắp sang đúng cột.`);
    const gallery = text(7).split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    if (gallery.some(path => !productImagePattern.test(path)) || new Set(gallery).size !== gallery.length || gallery.length > MAX_PRODUCT_GALLERY) throw new Error(`Gallery không hợp lệ tại dòng ${index}.`);
    const rawListPrice = text(16), missingPrice = !rawListPrice;
    const numericPrice = missingPrice ? 0 : Number(rawListPrice);
    if (!Number.isFinite(numericPrice) || numericPrice < 0 || numericPrice > MAX_PRODUCT_PRICE) throw new Error(`Giá không hợp lệ tại dòng ${index}.`);
    const listPrice = Math.round(numericPrice);
    const sourceText = text(6);
    let sourceUrl = "";
    if (/^https:\/\//i.test(sourceText)) {
      const url = new URL(sourceText);
      if (!/^(?:www\.)?hafele\.com\.vn$/i.test(url.hostname) || url.username || url.password || url.port) throw new Error(`URL nguồn HAFELE không hợp lệ ở dòng ${index}.`);
      sourceUrl = url.href;
    }
    const messages = [missingPrice ? "Thiếu giá nguồn: lưu giá 0 và giữ riêng tư để bổ sung." : "",
      numericPrice !== listPrice ? `Làm tròn giá niêm yết từ ${rawListPrice} thành ${listPrice} VNĐ.` : "",
      !gallery.length ? "Chưa có gallery trong Excel; giữ riêng tư." : "",
      sourceText && !sourceUrl ? "Không có URL nguồn hợp lệ trong Excel." : ""].filter(Boolean);
    if (messages.length) warnings.push({ row: index, code, messages });
    rows.push({ row: index, family: sheet.getCell(index, 1).master.address, stt: text(1), code, masterSku: text(4), name: text(5), categoryPath,
      sourceUrl, gallery, shortDescription: text(8), information: text(9), technicalDetails: text(10), usageGuide: text(11), packaging: text(12),
      unit: text(13), cabinet: text(14), dimensions: text(15), listPrice, rawListPrice, missingPrice, b2cDiscount: percent(sheet.getCell(index, 17)), b2bDiscount: percent(sheet.getCell(index, 19)) });
  }
  if (!rows.length) throw new Error("Không có dòng sản phẩm HAFELE.");
  return { sheet: sheet.name, hash: createHash("sha256").update(bytes).digest("hex"), rows, warnings };
}

// Aliases reuse established categories without renaming, moving or updating them.
const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  "thiết bị bếp": "thiet-bi-bep-gia-dung",
  "chậu rửa, vòi rửa": "chau-voi-rua-bat",
  "phụ kiện ngành gỗ": "phu-kien-noi-that",
  "bản lề cánh tủ": "ban-le",
  "ray ngăn kéo": "ray-truot",
  "phuộc hơi pittong đẩy cánh tủ": "piston-hoi-thuy-luc",
};

function stableCategorySlug(path: string[]): string {
  const raw = `hafele-${path.map(importSlug).join("-")}`;
  if (raw.length <= CATEGORY_SLUG_LIMIT) return raw;
  const hash = createHash("sha256").update(JSON.stringify(path.map(key))).digest("hex").slice(0, SLUG_HASH_LENGTH);
  return `${raw.slice(0, CATEGORY_SLUG_LIMIT - SLUG_HASH_LENGTH - 1).replace(/-$/, "")}-${hash}`;
}

function commonPath(paths: string[][]): string[] {
  let length = paths[0].length;
  for (const path of paths.slice(1)) {
    let index = 0;
    while (index < length && index < path.length && key(path[index]) === key(paths[0][index])) index++;
    length = index;
  }
  return paths[0].slice(0, length);
}

function assertDto(dto: ProductDto | CategoryDto, label: string) {
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) throw new Error(`${label}: ${errors.map(error => `${error.property}: ${Object.values(error.constraints || {}).join(", ")}`).join("; ")}`);
}

function labeled(text: string, label: string, limit = 100) {
  return text.match(new RegExp(`(?:^|\\n)\\s*[•*\\-]?\\s*(?:${label})\\s*:\\s*([^\\n]+)`, "iu"))?.[1].trim().slice(0, limit) || "";
}
const millimeters = (value: string) => /^\d+(?:-\d+)?$/.test(value) ? `${value}mm` : value;
function variantValues(row: HafeleRow) {
  const text = joined([row.packaging, row.shortDescription]);
  const capacity = text.match(/Dung tích\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:lít|lit|l\b)/iu)?.[1];
  const color = row.packaging.match(/(?:^|\n|\|)\s*Màu\s+([^|(\n]+)/iu)?.[1].trim() || labeled(text, "Màu(?: sắc)?");
  const direction = /trung tâm/iu.test(row.packaging) ? "Trung tâm" : /\bphải\b/iu.test(row.packaging) ? "Phải" : /trái/iu.test(row.packaging) ? "Trái" : "";
  return [millimeters(row.cabinet), capacity ? `${capacity} L` : "", color, direction, row.dimensions];
}

function groupAttributes(rows: HafeleRow[]) {
  const names = ["Kích thước", "Dung tích", "Màu sắc", "Hướng", "Kích thước sản phẩm"];
  const values = rows.map(variantValues);
  const selected: number[] = [];
  for (let dimension = 0; dimension < names.length; dimension++) {
    const column = values.map(row => row[dimension]);
    if (column.some(value => !value) || new Set(column.map(key)).size < 2) continue;
    selected.push(dimension);
    if (new Set(values.map(row => JSON.stringify(selected.map(index => key(row[index]))))).size === rows.length) break;
  }
  const attributes = values.map(row => selected.map(index => ({ name: names[index], value: row[index] })));
  if (new Set(attributes.map(value => JSON.stringify(value))).size !== rows.length) throw new Error(`Chưa đủ thuộc tính phân biệt nhóm STT ${rows[0].stt}: ${rows.map(row => row.code).join(", ")}.`);
  return attributes;
}

export function buildHafeleImport(workbook: HafeleWorkbook, existing: HafeleCategoryRow[]): HafeleImportPlan {
  const categories: Category[] = [], all = existing.map(row => ({ ...row.data, slug: row.slug }));
  const mappings = new Map<string, { path: string[]; slug: string; reused: boolean }>();
  const existingSlugs = new Set(existing.map(row => row.slug));
  const warnings = structuredClone(workbook.warnings);
  function ensurePath(path: string[]): string {
    let parentSlug = "";
    for (let level = 0; level < path.length; level++) {
      const prefix = path.slice(0, level + 1), mapKey = JSON.stringify(prefix.map(key));
      const mapped = mappings.get(mapKey);
      if (mapped) { parentSlug = mapped.slug; continue; }
      const name = sentenceCaseCategoryName(path[level]), alias = CATEGORY_ALIASES[key(name)];
      const found = all.find(category => (category.parentSlug || "") === parentSlug && (key(category.name) === key(name) || category.slug === alias));
      const slug = found?.slug || stableCategorySlug(prefix);
      if (!found) {
        if (all.some(category => category.slug === slug)) throw new Error(`Slug danh mục bị trùng: ${slug}.`);
        const category: Category = { slug, name, parentSlug, image: "", description: "", subcategories: [], visible: false, sortOrder: (all.length + 1) * 10 };
        categories.push(category); all.push(category);
      }
      mappings.set(mapKey, { path: prefix, slug, reused: existingSlugs.has(slug) });
      parentSlug = slug;
    }
    return parentSlug;
  }
  for (const row of workbook.rows) ensurePath(row.categoryPath);
  assertCategoryTree(all);
  const byCode = new Map<string, HafeleRow[]>();
  for (const row of workbook.rows) { const members = byCode.get(key(row.code)) || []; members.push(row); byCode.set(key(row.code), members); }
  const sourceById = new Map<string, HafeleRow>();
  const products = [...byCode.values()].map(members => {
    const row = members[0];
    const identities = members.map(member => JSON.stringify([key(member.name), member.unit, member.listPrice, member.rawListPrice, member.b2cDiscount, member.b2bDiscount, member.gallery, member.sourceUrl, member.cabinet, member.dimensions,
      member.shortDescription, member.information, member.technicalDetails, member.usageGuide]));
    if (new Set(identities).size !== 1) throw new Error(`SKU trùng có dữ liệu không thống nhất: ${row.code}, dòng ${members.map(member => member.row).join(", ")}.`);
    const path = commonPath(members.map(member => member.categoryPath));
    if (!path.length) throw new Error(`SKU ${row.code} thuộc các danh mục không có cha chung.`);
    const category = ensurePath(path), id = randomUUID();
    const suffix = importSlug(row.code);
    const slug = `${importSlug(row.name).slice(0, PRODUCT_SLUG_LIMIT - suffix.length - 1).replace(/-$/, "")}-${suffix}`;
    const packaging = joined(members.map(member => member.packaging));
    const description = joined([row.information, packaging]);
    const technicalDetails = joined([row.technicalDetails, row.cabinet ? `Khoang tủ: ${millimeters(row.cabinet)}` : "", row.dimensions ? `Kích thước sản phẩm: ${row.dimensions}` : ""], "\n");
    const content = joined([packaging, row.technicalDetails, row.shortDescription, row.information], "\n");
    const color = variantValues(row)[2];
    const material = labeled(content, "Chất liệu|Material");
    const warranty = content.split("\n").filter(line => /bảo hành/iu.test(line)).join("; ").slice(0, SUMMARY_LIMIT);
    const specification = joined([row.cabinet ? `Khoang tủ ${millimeters(row.cabinet)}` : "", row.dimensions, row.shortDescription, packaging, row.technicalDetails], " · ").slice(0, SUMMARY_LIMIT);
    const payload = { name: row.name, code: row.code, slug, category, subcategory: "", brand: HAFELE_BRAND, unit: row.unit,
      ...resolveProductPricing({ listPrice: row.listPrice, b2cDiscount: row.b2cDiscount, b2bDiscount: row.b2bDiscount }),
      specification, material, color, size: row.dimensions || millimeters(row.cabinet), origin: "", description,
      sourceUrl: row.sourceUrl, shortDescription: row.shortDescription, technicalDetails, usageGuide: row.usageGuide, warranty,
      gallery: row.gallery, featured: false, showAuthenticityLabel: true, published: false };
    assertDto(plainToInstance(ProductDto, payload), `SKU ${row.code}`);
    const { published: _published, ...fields } = payload;
    const data: Product = { ...fields, id, image: row.gallery[0] || "", stock: 0 };
    sourceById.set(id, row);
    if (members.length > 1) warnings.push({ row: row.row, code: row.code, messages: [`Gộp ${members.length} dòng cùng SKU; dùng danh mục cha chung ${path.join(" | ")}; giữ các mô tả nguồn.`] });
    for (const node of categoryTrail(all, category)) {
      const created = categories.find(item => item.slug === node.slug);
      if (created && !created.image && data.image) created.image = data.image;
    }
    return { data, published: false as const, sourceRows: members.map(member => member.row), sourcePaths: members.map(member => member.categoryPath), masterSkus: [...new Set(members.map(member => member.masterSku).filter(Boolean))] };
  });
  const families = new Map<string, typeof products>();
  for (const product of products) { const family = sourceById.get(product.data.id)!.family; const members = families.get(family) || []; members.push(product); families.set(family, members); }
  let variantGroups = 0;
  for (const members of families.values()) {
    if (members.length < 2) continue;
    const attributes = groupAttributes(members.map(member => sourceById.get(member.data.id)!));
    const root = members[0].data;
    for (const [index, member] of members.entries()) {
      if (member.data.category !== root.category || member.data.unit !== root.unit) throw new Error(`Nhóm biến thể ${root.code} khác danh mục hoặc đơn vị.`);
      member.data.variantGroupId = root.id; member.data.variantAttributes = attributes[index];
      member.data.size = attributes[index].find(attribute => attribute.name === "Kích thước")?.value || member.data.size;
      const { id: _id, image: _image, stock: _stock, ...fields } = member.data;
      assertDto(plainToInstance(ProductDto, { ...fields, published: false }), `Biến thể ${member.data.code}`);
    }
    validateVariantGroupConfiguration(members.map(member => member.data), root, []);
    variantGroups++;
  }
  if (new Set(products.map(product => product.data.slug)).size !== products.length) throw new Error("Đường dẫn sản phẩm bị trùng.");
  for (const category of categories) assertDto(plainToInstance(CategoryDto, category), `Danh mục ${category.name}`);
  return { version: HAFELE_IMPORT_VERSION, workbookHash: workbook.hash, sourceRows: workbook.rows.length, categories, products, categoryMappings: [...mappings.values()], reusedCategorySlugs: [...new Set([...mappings.values()].filter(item => item.reused).map(item => item.slug))], warnings, variantGroups };
}
