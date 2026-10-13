import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { MAX_PRODUCT_GALLERY } from "./product.constants";

const HEADER_ROW = 4;
const EXPECTED_HEADERS = ["STT", "Nhóm sản phẩm", "Mã sản phẩm", "Mã SP mới", "Tên sản phẩm (Web mẫu)", "Link sản phẩm mẫu", "Gallery (Link ảnh)", "Nội dung ngắn (Web)", "Thông tin sản phẩm (Web)", "Thông số (Web)", "Hướng dẫn sử dụng (Web)", "Mô tả Sản phẩm & Quy cách", "ĐVT", "Khoang tủ", "Giá niêm yết (VNĐ)", "Chiết khấu", "Giá sau CK (VNĐ)", "Trang catalog"];
export const SOURCE_HOST = "fulco.vn";

export type FulcoRow = {
  row: number; code: string; alternateCode: string; name: string; missingName: boolean;
  group: string; sourceUrl: string; sourceImages: string[]; shortDescription: string;
  description: string; technicalDetails: string; usageGuide: string; size: string;
  material: string; color: string; warranty: string; unit: string; listPrice: number;
  discount: number; specification: string; catalogPage: string;
};
export type FulcoWorkbook = { sheet: string; hash: string; rows: FulcoRow[]; warnings: { row: number; code: string; messages: string[] }[] };
const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
export const importSlug = (value: string) => normalized(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function cellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).normalize("NFC").trim();
  if (typeof value === "object" && "hyperlink" in value) return String(value.hyperlink).trim();
  if (typeof value === "object" && "richText" in value) return value.richText.map(item => item.text).join("").normalize("NFC").trim();
  throw new Error(`Unsupported input cell ${cell.address}.`);
}

function sourceURL(value: string, image = false) {
  if (!value || !/^https:\/\//i.test(value)) { if (image) throw new Error("Gallery must contain HTTPS image links."); return ""; }
  const url = new URL(value);
  if (url.hostname !== SOURCE_HOST || url.username || url.password || url.port || (image && !url.pathname.startsWith("/static/media/"))) throw new Error("Only Fulco source links are supported.");
  url.hash = "";
  return url.href;
}

function detailValue(text: string, label: string, max = 100) {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*[•*\\-]?\\s*${label}\\s*:{1,2}\\s*([^\\n]+)`, "i"));
  return match ? match[1].trim().slice(0, max) : "";
}

export async function parseFulcoWorkbook(bytes: Buffer): Promise<FulcoWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The workbook has no first sheet.");
  EXPECTED_HEADERS.forEach((header, index) => {
    if (normalized(cellText(sheet.getRow(HEADER_ROW).getCell(index + 1))) !== normalized(header)) throw new Error(`Unexpected first-sheet header at column ${index + 1}.`);
  });
  const rows: FulcoRow[] = [];
  const warnings: FulcoWorkbook["warnings"] = [];
  const codes = new Set<string>();
  for (let index = HEADER_ROW + 1; index <= sheet.rowCount; index++) {
    const input = sheet.getRow(index);
    const text = (column: number) => cellText(input.getCell(column));
    const code = text(3);
    if (!code) continue;
    const key = normalized(code).toLowerCase();
    if (codes.has(key)) throw new Error(`Duplicate SKU at row ${index}.`);
    codes.add(key);
    const group = text(2), originalName = text(5), originalDescription = text(12);
    const missingName = !originalName || originalName === "-";
    const name = missingName ? `Fulco ${code}` : normalized(originalName);
    const shortDescription = text(8), information = text(9), technicalDetails = text(10), usageGuide = text(11);
    const description = [...new Set([originalDescription, information].filter(Boolean))].join("\n\n");
    const listPrice = input.getCell(15).value, discount = input.getCell(16).value;
    if (typeof listPrice !== "number" || !Number.isSafeInteger(listPrice) || listPrice <= 0 || typeof discount !== "number" || discount < 0 || discount > 1) throw new Error(`Invalid list price or percentage at row ${index}.`);
    const sourceImages = [...new Set(text(7).split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(value => sourceURL(value, true)))];
    if (sourceImages.length > MAX_PRODUCT_GALLERY) throw new Error(`Row ${index} exceeds the gallery limit.`);
    const sourceText = [originalDescription, technicalDetails, shortDescription].join("\n");
    const material = detailValue(sourceText, "Chất liệu"), color = detailValue(sourceText, "Màu(?: sắc)?");
    const rawSize = text(14), size = /^\d+$/.test(rawSize) ? `${rawSize}mm` : rawSize;
    const warranty = [...new Set(sourceText.split("\n").map(line => line.replace(/^[•*\-]\s*/, "").trim()).filter(line => /bảo hành/i.test(line)))].join("; ").slice(0, 500);
    const specification = [size, material, ...shortDescription.split("\n").filter(Boolean)].filter(Boolean).join(" · ").slice(0, 500) || originalDescription.split("\n")[0].slice(0, 500);
    if (!group || group.length > 120 || name.length > 200 || code.length > 80 || description.length > 10000 || shortDescription.length > 2000 || technicalDetails.length > 10000 || usageGuide.length > 20000) throw new Error(`A field exceeds the supported length at row ${index}.`);
    rows.push({ row: index, code, alternateCode: text(4), name, missingName, group, sourceUrl: sourceURL(text(6)), sourceImages, shortDescription, description, technicalDetails, usageGuide, size, material, color, warranty, unit: text(13), listPrice, discount: Math.round(discount * 10000) / 100, specification, catalogPage: text(18) });
    const messages = [missingName ? "Missing source product name; keep private." : "", !sourceImages.length ? "Missing gallery; keep private." : "", !technicalDetails ? "No detailed specification in source." : ""].filter(Boolean);
    if (messages.length) warnings.push({ row: index, code, messages });
  }
  if (!rows.length) throw new Error("The first sheet has no product rows.");
  return { sheet: sheet.name, hash: createHash("sha256").update(bytes).digest("hex"), rows, warnings };
}

export function fulcoVariantGroups(rows: FulcoRow[]) {
  const groups = new Map<string, FulcoRow[]>();
  for (const row of rows) {
    const key = row.sourceUrl && !row.missingName ? JSON.stringify([row.group, row.sourceUrl, normalized(row.name).toLowerCase()]) : row.code;
    const members = groups.get(key) || [];
    members.push(row); groups.set(key, members);
  }
  return [...groups.values()].map(members => {
    if (members.length === 1) return { members, attributes: new Map<string, { name: string; value: string }[]>() };
    const dimensions: ("size" | "color")[] = [];
    for (const key of ["size", "color"] as const) if (members.every(item => item[key]) && new Set(members.map(item => item[key])).size > 1) dimensions.push(key);
    const attributes = new Map(members.map(row => [row.code, dimensions.map(key => ({ name: key === "size" ? "Kích thước" : "Màu sắc", value: row[key] }))]));
    const signatures = [...attributes.values()].map(items => JSON.stringify(items));
    if (!dimensions.length || new Set(signatures).size !== members.length) for (const row of members) attributes.get(row.code)!.push({ name: "Phiên bản", value: row.code });
    return { members, attributes };
  });
}
