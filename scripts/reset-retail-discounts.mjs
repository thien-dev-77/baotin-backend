import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { resolveProductPricing } from "../dist/catalog/product-pricing.js";

const COMMAND_LOCK = 82610477;
const ACTION = "catalog-retail-discount-reset";
const VERSION = "catalog-b2c-zero-v1";
const ACTOR = "maintenance:catalog-retail-pricing";
const RETAIL_DISCOUNT = 0;

function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "audit_events"].includes(name)) throw new Error("Unknown retail pricing table.");
  return `"${schema}"."${name}"`;
}

export function retailPricingChanges(products) {
  return products.flatMap(row => {
    const pricing = resolveProductPricing({ listPrice: row.data.listPrice, b2cDiscount: RETAIL_DISCOUNT, b2bDiscount: row.data.b2bDiscount });
    if (row.data.b2cDiscount === RETAIL_DISCOUNT && row.data.price === pricing.price && !("oldPrice" in row.data)) return [];
    return [{ id: row.id, revision: row.revision, code: row.data.code, previousDiscount: row.data.b2cDiscount, previousPrice: row.data.price, price: pricing.price }];
  });
}

export async function resetRetailDiscounts(client, schema, { apply = false, backupPath } = {}) {
  table(schema, "products");
  await client.query("BEGIN");
  try {
    if (apply) await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    else await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const previous = (await client.query(`SELECT detail FROM ${table(schema, "audit_events")} WHERE action=$1 AND "resourceId"=$2 LIMIT 1`, [ACTION, VERSION])).rows[0];
    if (previous) {
      await client.query("ROLLBACK");
      return { applied: false, alreadyApplied: true, summary: previous.detail.summary, backupPath: previous.detail.backupPath };
    }
    const products = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id${apply ? " FOR UPDATE" : ""}`)).rows;
    const changes = retailPricingChanges(products);
    const summary = { products: products.length, updated: changes.length, published: products.filter(row => row.published).length, private: products.filter(row => !row.published).length, b2cDiscount: RETAIL_DISCOUNT };
    if (!apply || !changes.length) {
      await client.query("ROLLBACK");
      return { applied: false, alreadyApplied: false, summary, changes, backupPath: null };
    }
    if (!backupPath) throw new Error("A new backup path is required before applying changes.");
    const contents = JSON.stringify({ version: VERSION, at: new Date().toISOString(), schema, products, changes }, null, 2);
    const checksum = createHash("sha256").update(contents).digest("hex");
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    const handle = await open(backupPath, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    if (createHash("sha256").update(await readFile(backupPath)).digest("hex") !== checksum) throw new Error("Backup verification failed.");
    const result = await client.query(`UPDATE ${table(schema, "products")} AS p SET data=(p.data-'oldPrice')||jsonb_build_object('b2cDiscount',$2::int,'price',patch.price),revision=p.revision+1 FROM jsonb_to_recordset($1::jsonb) AS patch(id text,revision integer,price bigint) WHERE p.id=patch.id AND p.revision=patch.revision`, [JSON.stringify(changes), RETAIL_DISCOUNT]);
    if (result.rowCount !== changes.length) throw new Error("Products changed concurrently. Rolling back.");
    const after = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id`)).rows;
    const protectedFields = row => {
      const { price, oldPrice, b2cDiscount, ...data } = row.data;
      const { revision, ...rest } = row;
      return { ...rest, data };
    };
    if (JSON.stringify(products.map(protectedFields)) !== JSON.stringify(after.map(protectedFields))) throw new Error("Product fields other than retail pricing changed. Rolling back.");
    if (retailPricingChanges(after).length) throw new Error("Retail prices were not updated completely. Rolling back.");
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, [ACTOR, ACTION, VERSION, JSON.stringify({ backupPath, checksum, summary, changes })]);
    await client.query("COMMIT");
    return { applied: true, alreadyApplied: false, summary, changes, backupPath, checksum };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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
    const result = await resetRetailDiscounts(client, schema, { apply: process.argv.includes("--apply"), backupPath: resolve("backups/retail-pricing", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`) });
    console.log(JSON.stringify({ stage: result.applied ? "applied" : "preview", alreadyApplied: result.alreadyApplied, ...result.summary, sample: result.changes?.slice(0, 5), backupPath: result.backupPath }, null, 2));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Retail pricing reset stopped: ${error.message}`); process.exitCode = 1; });
