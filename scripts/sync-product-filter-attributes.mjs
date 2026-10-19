import "reflect-metadata";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { config } from "dotenv";
import pg from "pg";
import { inferredFacetGroups, PRODUCT_FACET_FIELDS, PRODUCT_FACETS } from "../dist/catalog/product-filter-attributes.js";
import { readHafeleCatalog, hafeleCatalogChecksum } from "./import-hafele.mjs";

const VERSION = "product-filter-attributes-v1";
const COMMAND_LOCK = 82610477;
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "audit_events"].includes(name)) throw new Error("Unknown sync table.");
  return `"${schema}"."${name}"`;
}

export function planProductFilterSync(products) {
  const changes = [], unknown = [], brands = {};
  const fields = Object.fromEntries(PRODUCT_FACET_FIELDS.map(field => [field, { populated: 0, blank: 0, manualPreserved: 0, groups: {} }]));
  for (const row of products) {
    const patch = {};
    for (const field of PRODUCT_FACET_FIELDS) {
      const key = PRODUCT_FACETS[field].selectionField;
      if (Array.isArray(row.data[key])) { fields[field].manualPreserved++; continue; }
      const text = row.data[field] || "";
      if (!text.trim()) { fields[field].blank++; continue; }
      const groups = inferredFacetGroups(field, text);
      patch[key] = groups;
      fields[field].populated++;
      for (const group of groups) fields[field].groups[group] = (fields[field].groups[group] || 0) + 1;
      if (groups.includes("other")) unknown.push({ id: row.id, code: row.data.code, brand: row.data.brand, field, text });
    }
    if (!Object.keys(patch).length) continue;
    changes.push({ id: row.id, code: row.data.code, revision: row.revision, patch });
    brands[row.data.brand] = (brands[row.data.brand] || 0) + 1;
  }
  return { total: products.length, updated: changes.length, brands, fields, unknown, changes };
}

export async function syncProductFilterAttributes(client, schema, { apply = false, expectedChecksum, backupPath } = {}) {
  await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    if (apply) {
      await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
      await client.query(`LOCK TABLE ${table(schema, "products")}, ${table(schema, "categories")} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const before = await readHafeleCatalog(client, schema);
    const checksum = hafeleCatalogChecksum(before);
    const plan = planProductFilterSync(before.products);
    if (!apply || !plan.updated) { await client.query("ROLLBACK"); return { applied: false, checksum, ...plan }; }
    if (checksum !== expectedChecksum) throw new Error("Catalog changed since preview. Generate a fresh plan before applying.");
    if (!backupPath) throw new Error("A new backup path is required.");
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFile(backupPath, JSON.stringify({ version: VERSION, at: new Date().toISOString(), checksum, ...before, plan }, null, 2), { flag: "wx", mode: 0o600 });
    const updated = await client.query(`UPDATE ${table(schema, "products")} p SET data=p.data || patch.data,revision=p.revision+1
      FROM jsonb_to_recordset($1::jsonb) AS patch(id text,revision integer,data jsonb)
      WHERE p.id=patch.id AND p.revision=patch.revision RETURNING p.id`,
    [JSON.stringify(plan.changes.map(change => ({ id: change.id, revision: change.revision, data: change.patch })))]);
    if (updated.rowCount !== plan.updated) throw new Error("A product changed concurrently. Rolling back.");
    const changed = new Map(plan.changes.map(change => [change.id, change]));
    const expected = { ...before, products: before.products.map(row => {
      const change = changed.get(row.id);
      return change ? { ...row, revision: row.revision + 1, data: { ...row.data, ...change.patch } } : row;
    }) };
    const after = await readHafeleCatalog(client, schema);
    if (!isDeepStrictEqual(after, expected)) throw new Error("Data other than filter groups/revisions changed. Rolling back.");
    const { changes, ...summary } = plan;
    const detail = { version: VERSION, backupPath, beforeChecksum: checksum, afterChecksum: hafeleCatalogChecksum(after), ...summary };
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, ["maintenance:product-filters", "product-filter-attributes-sync", VERSION, JSON.stringify(detail)]);
    await client.query("COMMIT");
    return { applied: true, ...detail, changes };
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
    const directory = resolve("backups/product-filter-attributes");
    const result = await syncProductFilterAttributes(client, schema, { apply: process.argv.includes("--apply"), expectedChecksum: argument("--expected-checksum"), backupPath: resolve(directory, `${Date.now()}-before.json`) });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const reportPath = resolve(directory, result.applied ? "latest-result.json" : "latest-plan.json");
    await writeFile(reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    const { changes, unknown, ...summary } = result;
    console.log(JSON.stringify({ ...summary, unknownCount: unknown.length, reportPath }, null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Product filter sync stopped: ${error.message}`); process.exitCode = 1; });
