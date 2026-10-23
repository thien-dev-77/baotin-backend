import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ExcelJS from "exceljs";
import { config } from "dotenv";
import pg from "pg";
import { sentenceCaseProductName } from "../dist/catalog/product-name.js";
import { inferredFacetGroups } from "../dist/catalog/product-filter-attributes.js";

export const APPLIANCE_SHEET = "SKU Độc Bản (186 SP)";
export const APPLIANCE_HEADERS = ["STT", "Danh mục sản phẩm", "Mã sản phẩm (Art.No.)", "Model", "Tên sản phẩm", "Màu sắc / Hoàn thiện", "Giá có VAT (VNĐ)", "Kích thước sản phẩm", "Kích thước cắt đá / lắp đặt", "Đặc tính sản phẩm / Performance", "Thông tin kỹ thuật / Specifications", "Trang"];
const BRAND = "HAFELE";
const VERSION = "hafele-appliances-content-v1";
const ACTION = "hafele-appliances-content-update";
const COMMAND_LOCK = 82610495;
const MUTABLE_FIELDS = new Set(["name", "color", "colorGroups", "size", "description", "shortDescription", "technicalDetails", "specification"]);
const LIMITS = { name: 200, color: 100, size: 100, description: 10000, shortDescription: 2000, technicalDetails: 10000, specification: 500 };
const normalizeCode = value => value.normalize("NFC").trim().replace(/[.\s-]/g, "").toUpperCase();
const normalizeLabel = value => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").trim().toLowerCase();
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const applianceChecksum = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "audit_events"].includes(name)) throw new Error("Unknown maintenance table.");
  return `"${schema}"."${name}"`;
}

export async function parseAppliancesWorkbook(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.getWorksheet(APPLIANCE_SHEET);
  if (!sheet) throw new Error(`Missing authoritative unique-SKU sheet: ${APPLIANCE_SHEET}`);
  APPLIANCE_HEADERS.forEach((header, index) => {
    if (sheet.getCell(4, index + 1).text.trim() !== header) throw new Error(`Unexpected header at column ${index + 1}.`);
  });
  const rows = [], codes = new Set();
  sheet.eachRow((row, index) => {
    if (index <= 4 || !row.getCell(3).text.trim()) return;
    const text = column => {
      const cell = row.getCell(column);
      if (cell.value && typeof cell.value === "object" && ("formula" in cell.value || "sharedFormula" in cell.value)) throw new Error(`Row ${index}, column ${column}: source text must not be a formula.`);
      return cell.text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
    };
    const code = text(3), key = normalizeCode(code);
    if (!/^\d{3}\.\d{2}\.\d{3}$/.test(code) || codes.has(key)) throw new Error(`Invalid or duplicate source SKU at row ${index}: ${code}`);
    codes.add(key);
    const item = { row: index, code, model: text(4), name: text(5), color: text(6), size: text(8), installation: text(9), performance: text(10), specifications: text(11) };
    if (!item.name) throw new Error(`Missing product name at row ${index}.`);
    rows.push(item);
  });
  if (!rows.length) throw new Error("Workbook has no product rows.");
  return { hash: createHash("sha256").update(buffer).digest("hex"), sheet: sheet.name, rows };
}

export function applianceProductName(row) {
  const modelTokens = new Map((row.model.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || [])
    .filter(token => /\p{L}/u.test(token) && /\d/.test(token)).map(token => [token.toLowerCase(), token]));
  let name = sentenceCaseProductName({ name: row.name.replace(/h[äa]fele/giu, "Hafele"), brand: "Hafele", code: row.code });
  for (const [token, model] of modelTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(escaped, "giu"), model);
  }
  // Keep named models (e.g. BLANCOZIA 8S), without uppercasing a generic whole name like SINK COMBO 1.
  if (row.model && !row.name.toLowerCase().startsWith(row.model.toLowerCase())) {
    const escaped = row.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(escaped, "giu"), row.model);
  }
  return name;
}

function dimensionKind(label) {
  const key = normalizeLabel(label);
  if (["kich thuoc san pham", "kich thuoc chau", "appliance dimensions", "overall dimensions"].includes(key)) return "size";
  if (["kich thuoc cat da", "kich thuoc lap dat", "kich thuoc cat da / lap dat", "cut-out dimensions", "installation dimensions"].includes(key)) return "installation";
  if (key === "mau sac / hoan thien") return "color";
  return "";
}

function technicalDetails(row, previous) {
  const prefixes = [["color", "Màu sắc / Hoàn thiện"], ["size", "Kích thước sản phẩm"], ["installation", "Kích thước cắt đá / lắp đặt"]]
    .filter(([key]) => row[key]).map(([key, label]) => `${label}: ${row[key]}`);
  const source = row.specifications || previous || "";
  const lines = source.split("\n").filter(line => {
    const match = line.replace(/^[\s•*+·-]+/, "").match(/^([^:]+):\s*(.*)$/);
    if (!match) return true;
    const kind = dimensionKind(match[1]);
    // Dedicated dimension columns take precedence over old dimensions and empty extraction labels.
    if (kind && row[kind] && !row.specifications) return false;
    return !(kind && row[kind] && (!match[2] || match[2].trim() === row[kind]));
  });
  return [...prefixes, ...lines].filter(Boolean).join("\n");
}

export function buildApplianceUpdate(workbook, catalog) {
  const index = new Map();
  for (const product of catalog.products) {
    if (product.data.brand !== BRAND) continue;
    const key = normalizeCode(product.data.code);
    index.set(key, [...(index.get(key) || []), product]);
  }
  const changes = [], unmatched = [], matchedIds = new Set();
  for (const row of workbook.rows) {
    const candidates = index.get(normalizeCode(row.code)) || [];
    if (!candidates.length) { unmatched.push({ code: row.code, name: row.name, row: row.row }); continue; }
    if (candidates.length !== 1) throw new Error(`Ambiguous existing HAFELE SKU: ${row.code}`);
    const current = candidates[0], next = { ...current.data, name: applianceProductName(row) };
    matchedIds.add(current.id);
    if (row.color) { next.color = row.color; next.colorGroups = inferredFacetGroups("color", row.color); }
    if (row.size) next.size = row.size;
    if (row.performance) { next.description = row.performance; next.shortDescription = row.performance; }
    if (row.color || row.specifications || row.size || row.installation) next.technicalDetails = technicalDetails(row, current.data.technicalDetails);
    next.specification = [row.model, row.size || current.data.size, row.color || current.data.color, row.installation ? `Lắp đặt: ${row.installation}` : ""].filter(Boolean).join(" · ") || current.data.specification;
    for (const [key, limit] of Object.entries(LIMITS)) {
      if (next[key] !== undefined && (typeof next[key] !== "string" || next[key].length > limit)) throw new Error(`${row.code}: ${key} exceeds the supported ${limit} characters. Nothing truncated.`);
    }
    const patch = Object.fromEntries([...MUTABLE_FIELDS].filter(key => !isDeepStrictEqual(next[key], current.data[key])).map(key => [key, next[key]]));
    if (Object.keys(patch).length) changes.push({ id: current.id, code: current.data.code, revision: current.revision, sourceRow: row.row, patch });
  }
  return { version: VERSION, sourceHash: workbook.hash, sheet: workbook.sheet, checksum: applianceChecksum(catalog), changes, unmatched, summary: {
    sourceSkus: workbook.rows.length, matched: matchedIds.size, updated: changes.length, unmatched: unmatched.length,
    fieldsUpdated: Object.fromEntries([...MUTABLE_FIELDS].map(key => [key, changes.filter(change => key in change.patch).length])),
    fulcoUnchanged: catalog.products.filter(row => row.data.brand === "Fulco").length,
    otherProductsUnchanged: catalog.products.length - changes.length,
  } };
}

export async function readApplianceCatalog(client, schema) {
  return { products: (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id`)).rows,
    categories: (await client.query(`SELECT * FROM ${table(schema, "categories")} ORDER BY slug`)).rows };
}

async function saveBackup(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  if (applianceChecksum(JSON.parse(await readFile(path, "utf8"))) !== applianceChecksum(value)) throw new Error("Backup verification failed.");
}

export async function commitApplianceUpdate(client, schema, plan, backupPath) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    await client.query(`LOCK TABLE ${table(schema, "products")}, ${table(schema, "categories")} IN SHARE ROW EXCLUSIVE MODE`);
    const before = await readApplianceCatalog(client, schema);
    if (applianceChecksum(before) !== plan.checksum) throw new Error("Catalog changed after preview. Generate a fresh plan.");
    const previous = new Map(before.products.map(product => [product.id, product]));
    for (const change of plan.changes) {
      const product = previous.get(change.id);
      if (!product || product.data.brand !== BRAND || product.revision !== change.revision || product.data.code !== change.code || Object.keys(change.patch).some(key => !MUTABLE_FIELDS.has(key))) throw new Error("Update exceeds the reviewed HAFELE content scope.");
    }
    if (!plan.changes.length) { await client.query("ROLLBACK"); return { applied: false, ...plan.summary }; }
    await saveBackup(backupPath, { at: new Date().toISOString(), version: VERSION, sourceHash: plan.sourceHash, checksum: plan.checksum, ...before, changes: plan.changes });
    const result = await client.query(`UPDATE ${table(schema, "products")} AS product SET data=product.data||patch.data,revision=product.revision+1 FROM jsonb_to_recordset($1::jsonb) AS patch(id text,data jsonb,revision integer) WHERE product.id=patch.id AND product.revision=patch.revision`, [JSON.stringify(plan.changes.map(change => ({ id: change.id, data: change.patch, revision: change.revision })))]);
    if (result.rowCount !== plan.changes.length) throw new Error("Concurrent product update. Rolling back.");
    const after = await readApplianceCatalog(client, schema), changes = new Map(plan.changes.map(change => [change.id, change]));
    const expected = before.products.map(product => { const change = changes.get(product.id); return change ? { ...product, data: { ...product.data, ...change.patch }, revision: product.revision + 1 } : product; });
    if (applianceChecksum({ products: expected, categories: before.categories }) !== applianceChecksum(after)) throw new Error("Catalog verification failed. Rolling back.");
    const verification = { productCount: after.products.length, categoryCount: after.categories.length, changedIds: plan.changes.map(change => change.id), afterChecksum: applianceChecksum(after), protectedFieldsPreserved: true, unmatchedNotCreated: true };
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, ["maintenance:hafele-appliances", ACTION, plan.sourceHash, JSON.stringify({ version: VERSION, backupPath, summary: plan.summary, verification })]);
    await client.query("COMMIT");
    return { applied: true, ...plan.summary, backupPath, verification };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  const fileIndex = process.argv.indexOf("--file"), file = process.argv[fileIndex + 1];
  if (fileIndex < 0 || !file || file.startsWith("--")) throw new Error("Use --file PATH_TO_APPLIANCES_XLSX.");
  const source = resolve(file), workbook = await parseAppliancesWorkbook(await readFile(source));
  const schema = process.env.DB_SCHEMA || "baotin_app";
  table(schema, "products");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) } : false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const catalog = await readApplianceCatalog(client, schema);
    await client.query("COMMIT");
    const plan = buildApplianceUpdate(workbook, catalog);
    const directory = resolve("backups/hafele-appliances-update", workbook.hash.slice(0, 16));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "plan.json"), JSON.stringify({ source, ...plan }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: "preview", ...plan.summary, planPath: join(directory, "plan.json") }));
    if (!process.argv.includes("--apply")) return;
    const result = await commitApplianceUpdate(client, schema, plan, join(directory, `before-${Date.now()}.json`));
    await writeFile(join(directory, "result.json"), JSON.stringify({ at: new Date().toISOString(), source, ...result }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: result.applied ? "applied" : "unchanged", ...result }));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`HAFELE content update stopped: ${error.message}`); process.exitCode = 1; });
