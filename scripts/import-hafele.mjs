import "reflect-metadata";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { parseHafeleWorkbook, buildHafeleImport, HAFELE_BRAND, HAFELE_IMPORT_VERSION } from "../dist/catalog/hafele-import.js";

const IMPORT_ACTION = "hafele-catalog-import";
const COMMAND_LOCK = 82610478;
const MEDIA_CONCURRENCY = 8;
const MEDIA_TIMEOUT_MS = 10_000;
const MEDIA_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const hafeleImportKey = workbookHash => hash({ version: HAFELE_IMPORT_VERSION, workbookHash });

function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "audit_events"].includes(name)) throw new Error("Unknown import table.");
  return `"${schema}"."${name}"`;
}

export async function readHafeleCatalog(client, schema) {
  const products = (await client.query(`SELECT id,slug,data,published,revision FROM ${table(schema, "products")} ORDER BY id`)).rows;
  const categories = (await client.query(`SELECT slug,data,revision FROM ${table(schema, "categories")} ORDER BY slug`)).rows;
  return { products, categories };
}
export const hafeleCatalogChecksum = catalog => hash(catalog);

export async function verifyHafeleMedia(paths, base, cache, fetcher = fetch) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Media base must be an HTTPS origin.");
  const unique = [...new Set(paths)];
  if (cache) {
    const age = Date.now() - Date.parse(cache.at);
    if (cache.base !== url.origin || !Number.isFinite(age) || age < 0 || age > MEDIA_CACHE_MAX_AGE_MS) throw new Error("Media verification cache is stale or targets another origin.");
    const checked = new Map(cache.results.map(result => [result.path, result]));
    if (unique.some(path => { const result = checked.get(path); return !result?.ok || result.status < 200 || result.status >= 300 || !result.type?.startsWith("image/"); })) throw new Error("Gallery contains an unverified or missing image.");
    return { ...cache, results: unique.map(path => checked.get(path)) };
  }
  let cursor = 0;
  const results = [];
  await Promise.all(Array.from({ length: MEDIA_CONCURRENCY }, async () => {
    while (cursor < unique.length) {
      const path = unique[cursor++];
      if (!/^\/media\/uploads\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(path)) throw new Error(`Invalid local gallery path: ${path}`);
      const response = await fetcher(`${url.origin}${path}`, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
      const type = response.headers.get("content-type");
      results.push({ path, status: response.status, type, ok: response.ok && Boolean(type?.startsWith("image/")) });
    }
  }));
  if (results.some(result => !result.ok)) throw new Error(`Missing/invalid server images: ${results.filter(result => !result.ok).map(result => result.path).join(", ")}`);
  return { base: url.origin, at: new Date().toISOString(), results };
}

export async function commitHafeleImport(client, schema, plan, { expectedChecksum, backupPath, media, reportPath }) {
  if (plan.products.some(item => item.data.brand !== HAFELE_BRAND || item.published !== false || item.data.stock !== 0)) throw new Error("HAFELE import must create private HAFELE SKUs with zero initial stock.");
  const importKey = hafeleImportKey(plan.workbookHash);
  const verified = new Set(media.results.filter(item => item.ok && item.status >= 200 && item.status < 300 && item.type?.startsWith("image/")).map(item => item.path));
  if (plan.products.some(item => item.data.gallery.some(path => !verified.has(path)))) throw new Error("An image has not been verified on the server.");
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    await client.query(`LOCK TABLE ${table(schema, "products")}, ${table(schema, "categories")} IN SHARE ROW EXCLUSIVE MODE`);
    const previous = (await client.query(`SELECT detail FROM ${table(schema, "audit_events")} WHERE action=$1 AND "resourceId"=$2 ORDER BY at DESC LIMIT 1`, [IMPORT_ACTION, importKey])).rows[0];
    if (previous) { await client.query("ROLLBACK"); return { alreadyImported: true, ...previous.detail.summary }; }
    const before = await readHafeleCatalog(client, schema);
    if (hafeleCatalogChecksum(before) !== expectedChecksum) throw new Error("Catalog changed after preview. Generate a fresh plan before importing.");
    const codes = new Set(before.products.map(row => row.data.code.trim().toLocaleLowerCase("vi")));
    const slugs = new Set(before.products.map(row => row.slug));
    const conflicts = plan.products.filter(item => codes.has(item.data.code.trim().toLocaleLowerCase("vi")) || slugs.has(item.data.slug));
    if (conflicts.length) throw new Error(`Existing SKU/slug conflicts; nothing overwritten: ${conflicts.map(item => item.data.code).join(", ")}`);
    const categorySlugs = new Set(before.categories.map(row => row.slug));
    if (plan.categories.some(item => categorySlugs.has(item.slug))) throw new Error("New category conflicts with an existing category.");
    // Persist the exact locked snapshot before the first insert; no credentials in backup.
    await writeFile(backupPath, JSON.stringify({ at: new Date().toISOString(), checksum: expectedChecksum, ...before }, null, 2), { flag: "wx", mode: 0o600 });
    await client.query(`INSERT INTO ${table(schema, "categories")} (slug,data,revision) SELECT slug,data,1 FROM jsonb_to_recordset($1::jsonb) AS imported(slug text,data jsonb)`, [JSON.stringify(plan.categories.map(data => ({ slug: data.slug, data })))]);
    await client.query(`INSERT INTO ${table(schema, "products")} (id,slug,data,published,revision) SELECT id,slug,data,false,1 FROM jsonb_to_recordset($1::jsonb) AS imported(id text,slug text,data jsonb)`, [JSON.stringify(plan.products.map(({ data }) => ({ id: data.id, slug: data.slug, data })))]);
    const after = await readHafeleCatalog(client, schema);
    const existingIds = new Set(before.products.map(row => row.id));
    const existingOnly = { products: after.products.filter(row => existingIds.has(row.id)), categories: after.categories.filter(row => categorySlugs.has(row.slug)) };
    if (hafeleCatalogChecksum(existingOnly) !== expectedChecksum) throw new Error("Existing catalog changed; transaction rolled back.");
    const summary = { products: plan.products.length, sourceRows: plan.sourceRows, categoriesCreated: plan.categories.length, categoriesReused: plan.reusedCategorySlugs.length,
      variantGroups: plan.variantGroups, private: plan.products.length, published: 0, productsWithoutGallery: plan.products.filter(item => !item.data.gallery.length).length,
      productsWithoutPrice: plan.products.filter(item => item.data.listPrice === 0).length, existingProductsUnchanged: before.products.length,
      fulcoProductsUnchanged: before.products.filter(row => row.data.brand.toLocaleLowerCase("vi") === "fulco").length, existingCatalogChecksum: expectedChecksum };
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, ["maintenance:hafele-import", IMPORT_ACTION, importKey,
      JSON.stringify({ workbookHash: plan.workbookHash, version: plan.version, reportPath, backupPath, mediaBase: media.base, summary, productIds: plan.products.map(item => item.data.id), categorySlugs: plan.categories.map(item => item.slug) })]);
    await client.query("COMMIT");
    return { alreadyImported: false, ...summary };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  const file = argument("--file");
  if (!file) throw new Error("Use --file PATH_TO_HAFELE_XLSX.");
  const workbook = await parseHafeleWorkbook(await readFile(resolve(file)));
  const schema = process.env.DB_SCHEMA || "baotin_app";
  table(schema, "products");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) } : false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis:10_000 });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const previous = (await client.query(`SELECT detail FROM ${table(schema, "audit_events")} WHERE action=$1 AND "resourceId"=$2 ORDER BY at DESC LIMIT 1`, [IMPORT_ACTION, hafeleImportKey(workbook.hash)])).rows[0];
    if (previous) {
      await client.query("COMMIT");
      console.log(JSON.stringify({ stage: "complete", alreadyImported: true, ...previous.detail.summary, reportPath: previous.detail.reportPath }));
      return;
    }
    const snapshot = await readHafeleCatalog(client, schema);
    await client.query("COMMIT");
    const plan = buildHafeleImport(workbook, snapshot.categories);
    const directory = resolve("backups/hafele-import", workbook.hash.slice(0, 16));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const reportPath = join(directory, "report.json");
    const checksum = hafeleCatalogChecksum(snapshot);
    await writeFile(reportPath, JSON.stringify({ stage: "preview", source: resolve(file), workbook, plan, existingCatalogChecksum: checksum }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: "preview", products: plan.products.length, sourceRows: plan.sourceRows, categoriesCreated: plan.categories.length, categoriesReused: plan.reusedCategorySlugs.length, variantGroups: plan.variantGroups, warnings: plan.warnings.length, reportPath }));
    if (!process.argv.includes("--apply")) return;
    const base = argument("--media-base");
    if (!base) throw new Error("Use --media-base HTTPS_API_ORIGIN to verify existing server images.");
    const cacheFile = argument("--media-check");
    const cache = cacheFile ? JSON.parse(await readFile(resolve(cacheFile), "utf8")) : undefined;
    const media = await verifyHafeleMedia(plan.products.flatMap(item => item.data.gallery), base, cache);
    const backupPath = join(directory, `before-${Date.now()}.json`);
    const summary = await commitHafeleImport(client, schema, plan, { expectedChecksum: checksum, backupPath, media, reportPath });
    await writeFile(reportPath, JSON.stringify({ stage: "complete", source: resolve(file), workbook, plan, media: { base: media.base, at: media.at, imagesVerified: media.results.length }, summary }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ stage: "complete", ...summary, reportPath }));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`HAFELE import stopped: ${error.message}`); process.exitCode = 1; });
