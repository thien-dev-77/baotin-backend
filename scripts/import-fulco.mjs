import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { JwtService } from "@nestjs/jwt";
import pg from "pg";
import { parseFulcoWorkbook } from "../dist/catalog/fulco-import.js";
import { buildFulcoImport, DEFAULT_FULCO_IMPORT_OPTIONS } from "../dist/catalog/fulco-import-plan.js";
import { exportImportedMedia, prepareFulcoMedia } from "./fulco-media.mjs";

const IMPORT_ACTION = "fulco-catalog-import";
const COMMAND_LOCK = 82610477;
const MEDIA_COOKIE = "baotin_session";
function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "users", "sessions", "audit_events"].includes(name)) throw new Error("Unknown import table.");
  return `"${schema}"."${name}"`;
}

export function importKey(workbookHash, options) {
  return createHash("sha256").update(JSON.stringify({ workbookHash, ...options })).digest("hex");
}

async function existingImport(client, schema, key) {
  const result = await client.query(`SELECT detail FROM ${table(schema, "audit_events")} WHERE action = $1 AND "resourceId" = $2 ORDER BY at DESC LIMIT 1`, [IMPORT_ACTION, key]);
  return result.rows[0]?.detail;
}

export async function commitFulcoImport(client, schema, key, plan, { actorId, workbookHash, options, reportPath }) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    const previous = await existingImport(client, schema, key);
    if (previous) { await client.query("ROLLBACK"); return { alreadyImported: true, ...previous.summary }; }
    const conflicts = await client.query(`SELECT id FROM ${table(schema, "products")} WHERE LOWER(TRIM(data->>'code')) = ANY($1::text[]) OR slug = ANY($2::text[])`, [plan.products.map(item => item.data.code.toLowerCase()), plan.products.map(item => item.data.slug)]);
    const categoryConflicts = await client.query(`SELECT slug FROM ${table(schema, "categories")} WHERE slug = ANY($1::text[])`, [plan.categories.map(item => item.slug)]);
    if (conflicts.rowCount || categoryConflicts.rowCount) throw new Error("Import conflicts with existing products or categories; no records were overwritten.");
    await client.query(`INSERT INTO ${table(schema, "categories")} (slug, data, revision) SELECT slug, data, 1 FROM jsonb_to_recordset($1::jsonb) AS imported(slug text, data jsonb)`, [JSON.stringify(plan.categories.map(data => ({ slug: data.slug, data })))]);
    await client.query(`INSERT INTO ${table(schema, "products")} (id, slug, data, published, revision) SELECT id, slug, data, published, 1 FROM jsonb_to_recordset($1::jsonb) AS imported(id text, slug text, data jsonb, published boolean)`, [JSON.stringify(plan.products.map(product => ({ id: product.data.id, slug: product.data.slug, data: product.data, published: product.published })))]);
    const summary = { products: plan.products.length, categories: plan.categories.length, published: plan.products.filter(item => item.published).length, private: plan.products.filter(item => !item.published).length, variants: plan.variantGroups, productsWithImages: plan.products.filter(item => item.data.gallery.length).length, productsWithoutImages: plan.products.filter(item => !item.data.gallery.length).length };
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId", action, "resourceId", detail) VALUES ($1, $2, $3, $4::jsonb)`, [actorId, IMPORT_ACTION, key, JSON.stringify({ workbookHash, options, reportPath, summary, rows: plan.products.map(item => ({ id: item.data.id, code: item.data.code })), warnings: plan.warnings })]);
    await client.query("COMMIT");
    return { alreadyImported: false, ...summary };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function maintenanceSession(client, schema, apiBase) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET is required for the temporary media-upload session.");
  const result = await client.query(`SELECT id FROM ${table(schema, "users")} WHERE disabled = false AND role IN ('admin', 'boss') ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id LIMIT 1`);
  const userId = result.rows[0]?.id;
  if (!userId) throw new Error("No active admin/boss account is available for media upload.");
  const sessionId = randomUUID();
  const token = await new JwtService({ secret: process.env.JWT_SECRET }).signAsync({ sub: userId, sid: sessionId }, { expiresIn: "2h", issuer: "baotin-api", audience: "baotin-web", algorithm: "HS256" });
  await client.query(`INSERT INTO ${table(schema, "sessions")} (id, "userId", "expiresAt") VALUES ($1, $2, $3)`, [sessionId, userId, new Date(Date.now() + 2 * 60 * 60 * 1000)]);
  const cookie = `${MEDIA_COOKIE}=${token}`;
  try {
    const response = await fetch(`${apiBase}/api/auth/session`, { headers: { Cookie: cookie }, redirect: "error", signal: AbortSignal.timeout(15000) });
    const data = response.ok ? await response.json() : null;
    if (data?.user?.id !== userId || !["admin", "boss"].includes(data.user.role)) throw new Error("The deployed backend rejected the operator session; verify JWT_SECRET and database configuration.");
    return { userId, sessionId, cookie };
  } catch (error) { await client.query(`DELETE FROM ${table(schema, "sessions")} WHERE id = $1`, [sessionId]); throw error; }
}

const argument = name => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  const file = argument("--file");
  if (!file) throw new Error("Use --file PATH_TO_FULCO_XLSX.");
  const target = argument("--discount-target") || DEFAULT_FULCO_IMPORT_OPTIONS.discountTarget;
  if (!["both", "b2b"].includes(target)) throw new Error("Discount target must be both or b2b.");
  const options = { discountTarget: target, b2cDiscount: Number(argument("--b2c-discount") ?? DEFAULT_FULCO_IMPORT_OPTIONS.b2cDiscount), publish: process.argv.includes("--publish-valid") };
  const workbook = await parseFulcoWorkbook(await readFile(resolve(file)));
  const key = importKey(workbook.hash, options);
  const directory = resolve("backups", "fulco-import", workbook.hash.slice(0, 16));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const reportPath = join(directory, `${key.slice(0, 16)}-report.json`);
  const previewPath = join(directory, `${key.slice(0, 16)}-preview.json`);
  const sourceURLs = [...new Set(workbook.rows.flatMap(row => row.sourceImages))];
  const previewURLs = new Map(sourceURLs.map((url, index) => [url, `/media/uploads/preview-${index}.webp`]));
  const preview = buildFulcoImport(workbook, previewURLs, options);
  await writeFile(previewPath, JSON.stringify({ stage: "preview", file: resolve(file), workbookHash: workbook.hash, sheet: workbook.sheet, options, rows: workbook.rows, warnings: preview.warnings }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage: "preview", sheet: workbook.sheet, products: preview.products.length, categories: preview.categories.length, variantGroups: preview.variantGroups, sourceImageURLs: sourceURLs.length, missingSourceName: workbook.rows.filter(row => row.missingName).length, productsWithoutGallery: workbook.rows.filter(row => !row.sourceImages.length).length, options, reportPath: previewPath }, null, 2));
  if (!process.argv.includes("--apply")) return;
  const apiBase = new URL(argument("--remote-api") || "");
  const origin = new URL(argument("--origin") || "");
  if (apiBase.protocol !== "https:" || origin.protocol !== "https:" || apiBase.username || apiBase.password || apiBase.pathname !== "/") throw new Error("Use HTTPS backend base URL and frontend origin.");
  const schema = process.env.DB_SCHEMA || "baotin_app";
  table(schema, "products");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) } : false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis: 7000 });
  await client.connect();
  let session;
  try {
    const previous = await existingImport(client, schema, key);
    if (previous) {
      try {
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        await writeFile(reportPath, JSON.stringify({ ...report, stage: "complete", summary: previous.summary }, null, 2), { mode: 0o600 });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      console.log(JSON.stringify({ alreadyImported: true, ...previous.summary }, null, 2)); return;
    }
    session = await maintenanceSession(client, schema, apiBase.origin);
    const media = await prepareFulcoMedia(sourceURLs, { cacheDir: join(directory, "media"), remote: { base: apiBase.origin, origin: origin.origin, cookie: session.cookie } });
    const bundled = await exportImportedMedia(media.manifestPath, resolve("media/imported/fulco"));
    const plan = buildFulcoImport(workbook, media.imageURLs, options);
    const report = { stage: "ready", file: resolve(file), workbookHash: workbook.hash, sheet: workbook.sheet, options, rows: workbook.rows, warnings: plan.warnings, imageFailures: media.failures, manifestPath: media.manifestPath, products: plan.products, categories: plan.categories };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    const result = await commitFulcoImport(client, schema, key, plan, { actorId: session.userId, workbookHash: workbook.hash, options, reportPath });
    await writeFile(reportPath, JSON.stringify({ ...report, stage: "complete", summary: result }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: "complete", ...result, uniqueStoredImages: media.uniqueImages, bundledMedia: bundled, failedSourceImages: media.failures.length, reportPath }, null, 2));
  } finally {
    if (session) await client.query(`DELETE FROM ${table(schema, "sessions")} WHERE id = $1`, [session.sessionId]);
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Fulco import stopped: ${error.message}`); process.exitCode = 1; });
