import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { FULCO_TAXONOMY_VERSION, planFulcoTaxonomy } from "../dist/catalog/fulco-taxonomy.js";

const COMMAND_LOCK = 82610477;
function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "audit_events"].includes(name)) throw new Error("Unknown taxonomy table.");
  return `"${schema}"."${name}"`;
}

export async function normalizeFulcoCategories(client, schema, { apply = false, backupPath } = {}) {
  table(schema, "products");
  await client.query("BEGIN");
  try {
    if (apply) await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    else await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const lock = apply ? " FOR UPDATE" : "";
    const categories = (await client.query(`SELECT * FROM ${table(schema, "categories")} ORDER BY slug${lock}`)).rows;
    const products = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id${lock}`)).rows;
    const plan = planFulcoTaxonomy(categories, products);
    if (!apply || !plan.categories.length && !plan.products.length) {
      await client.query("ROLLBACK");
      return { applied: false, ...plan, backupPath: null };
    }
    if (!backupPath) throw new Error("A new backup path is required before applying changes.");
    const backup = { version: FULCO_TAXONOMY_VERSION, at: new Date().toISOString(), schema, categories, products, plan };
    const contents = JSON.stringify(backup, null, 2);
    const checksum = createHash("sha256").update(contents).digest("hex");
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    const handle = await open(backupPath, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    if (createHash("sha256").update(await readFile(backupPath)).digest("hex") !== checksum) throw new Error("Backup verification failed. No data was changed.");
    for (const row of plan.categories) {
      if (!row.revision) {
        await client.query(`INSERT INTO ${table(schema, "categories")} (slug, data, revision) VALUES ($1, $2::jsonb, 1)`, [row.slug, JSON.stringify(row.data)]);
        continue;
      }
      const result = await client.query(`UPDATE ${table(schema, "categories")} SET data = $2::jsonb, revision = revision + 1 WHERE slug = $1 AND revision = $3`, [row.slug, JSON.stringify(row.data), row.revision]);
      if (result.rowCount !== 1) throw new Error(`Category changed concurrently: ${row.slug}.`);
    }
    for (const assignment of plan.products) {
      const result = await client.query(`UPDATE ${table(schema, "products")} SET data = jsonb_set(data, '{category}', to_jsonb($2::text)), revision = revision + 1 WHERE id = $1 AND revision = $3 AND data->>'category' = $4`, [assignment.id, assignment.to, assignment.revision, assignment.from]);
      if (result.rowCount !== 1) throw new Error(`Product changed concurrently: ${assignment.code}.`);
    }
    const after = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id`)).rows;
    const withoutCategory = row => { const { category, ...data } = row.data; const { revision, ...rest } = row; return { ...rest, data }; };
    if (JSON.stringify(products.map(withoutCategory)) !== JSON.stringify(after.map(withoutCategory))) throw new Error("Product data other than category changed. Rolling back.");
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId", action, "resourceId", detail) VALUES ($1, $2, $3, $4::jsonb)`, ["maintenance:fulco-taxonomy", "category-tree-normalize", FULCO_TAXONOMY_VERSION, JSON.stringify({ backupPath, checksum, summary: plan.summary, categorySlugs: plan.categories.map(row => row.slug), products: plan.products })]);
    await client.query("COMMIT");
    return { applied: true, ...plan, backupPath, checksum };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  const schema = process.env.DB_SCHEMA || "baotin_app";
  table(schema, "products");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) } : false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis: 7000 });
  await client.connect();
  try {
    const apply = process.argv.includes("--apply");
    const result = await normalizeFulcoCategories(client, schema, { apply, backupPath: resolve("backups/fulco-taxonomy", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`) });
    console.log(JSON.stringify({ stage: result.applied ? "applied" : "preview", ...result.summary, backupPath: result.backupPath, checksum: result.checksum, categories: result.categories.map(row => ({ slug: row.slug, name: row.data.name, parentSlug: row.data.parentSlug, new: !row.revision })), products: result.products.map(({ code, from, to }) => ({ code, from, to })) }, null, 2));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Taxonomy update stopped: ${error.message}`); process.exitCode = 1; });
