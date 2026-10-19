import "reflect-metadata";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { sentenceCaseCategoryName } from "../dist/catalog/category.rules.js";
import { readHafeleCatalog, hafeleCatalogChecksum } from "./import-hafele.mjs";

const VERSION = "hafele-category-sentence-case-v1";
const COMMAND_LOCK = 82610478;
function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "audit_events"].includes(name)) throw new Error("Unknown normalization table.");
  return `"${schema}"."${name}"`;
}

export async function normalizeHafeleCategories(client, schema, { apply = false, backupPath } = {}) {
  await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    if (apply) {
      await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
      await client.query(`LOCK TABLE ${table(schema, "products")}, ${table(schema, "categories")} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const imports = (await client.query(`SELECT detail FROM ${table(schema, "audit_events")} WHERE action=$1`, ["hafele-catalog-import"])).rows;
    const owned = new Set(imports.flatMap(row => row.detail.categorySlugs || []));
    if (!owned.size) throw new Error("No categories created by a completed HAFELE import were found.");
    const before = await readHafeleCatalog(client, schema);
    const changes = before.categories.filter(row => owned.has(row.slug)).map(row => ({ slug: row.slug, revision: row.revision, from: row.data.name, to: sentenceCaseCategoryName(row.data.name) })).filter(row => row.from !== row.to);
    if (!apply || !changes.length) {
      await client.query("ROLLBACK");
      return { applied: false, categories: changes, productsChanged: 0, backupPath: null };
    }
    if (!backupPath) throw new Error("A new backup path is required before updating category names.");
    const checksum = hafeleCatalogChecksum(before);
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFile(backupPath, JSON.stringify({ at: new Date().toISOString(), version: VERSION, checksum, ...before, changes }, null, 2), { flag: "wx", mode: 0o600 });
    for (const row of changes) {
      const result = await client.query(`UPDATE ${table(schema, "categories")} SET data=jsonb_set(data,'{name}',to_jsonb($1::text)),revision=revision+1 WHERE slug=$2 AND revision=$3`, [row.to, row.slug, row.revision]);
      if (result.rowCount !== 1) throw new Error(`Category changed concurrently: ${row.slug}.`);
    }
    const after = await readHafeleCatalog(client, schema);
    const changed = new Map(changes.map(row => [row.slug, row]));
    const restored = { products: after.products, categories: after.categories.map(row => {
      const previous = changed.get(row.slug);
      return previous ? { ...row, revision: previous.revision, data: { ...row.data, name: previous.from } } : row;
    }) };
    if (hafeleCatalogChecksum(restored) !== checksum) throw new Error("Data other than the selected category names/revisions changed. Rolling back.");
    const detail = { version: VERSION, backupPath, checksum, categories: changes, productsChanged: 0 };
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, ["maintenance:hafele-categories", "category-name-normalize", VERSION, JSON.stringify(detail)]);
    await client.query("COMMIT");
    return { applied: true, ...detail };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const schema = process.env.DB_SCHEMA || "baotin_app";
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) } : false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const result = await normalizeHafeleCategories(client, schema, { apply: process.argv.includes("--apply"), backupPath: resolve("backups/hafele-category-names", `${Date.now()}-before.json`) });
    const output = { ...result, changed: result.categories.length };
    if (result.applied) {
      const reportPath = resolve("backups/hafele-category-names", "latest-result.json");
      await writeFile(reportPath, JSON.stringify(output, null, 2), { mode: 0o600 });
      output.reportPath = reportPath;
    }
    console.log(JSON.stringify(output, null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`HAFELE category normalization stopped: ${error.message}`); process.exitCode = 1; });
