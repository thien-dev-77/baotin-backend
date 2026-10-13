import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { planCatalogRefresh, CATALOG_REFRESH_VERSION, CATALOG_INITIAL_STOCK } from "../dist/catalog/catalog-refresh-plan.js";

const COMMAND_LOCK = 82610477;
const ACTOR = "maintenance:catalog-stock-names";
function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "inventory_balances", "ledger_entries", "orders", "audit_events"].includes(name)) throw new Error("Unknown catalog refresh table.");
  return `"${schema}"."${name}"`;
}

export async function refreshCatalog(client, schema, { apply = false, backupPath } = {}) {
  table(schema, "products");
  await client.query("BEGIN");
  try {
    if (apply) await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    else await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const previous = (await client.query(`SELECT detail FROM ${table(schema, "audit_events")} WHERE action=$1 AND "resourceId"=$2 LIMIT 1`, ["catalog-stock-name-refresh", CATALOG_REFRESH_VERSION])).rows[0];
    if (previous) { await client.query("ROLLBACK"); return { applied: false, alreadyApplied: true, summary: previous.detail.summary, backupPath: previous.detail.backupPath }; }
    const lock = apply ? " FOR UPDATE" : "";
    const products = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id${lock}`)).rows;
    const inventory = (await client.query(`SELECT * FROM ${table(schema, "inventory_balances")} ORDER BY id${lock}`)).rows;
    const orders = (await client.query(`SELECT * FROM ${table(schema, "orders")} ORDER BY id${lock}`)).rows;
    const ledger = (await client.query(`SELECT * FROM ${table(schema, "ledger_entries")} WHERE kind='stock' ORDER BY reference${lock}`)).rows;
    const plan = planCatalogRefresh(products, inventory, orders);
    if (!apply || !plan.names.length && !plan.stock.length && !plan.adjustments.length) { await client.query("ROLLBACK"); return { applied: false, alreadyApplied: false, summary: plan.summary, names: plan.names, backupPath: null }; }
    if (!backupPath) throw new Error("A new backup path is required before applying changes.");
    const contents = JSON.stringify({ version: CATALOG_REFRESH_VERSION, at: new Date().toISOString(), schema, products, inventory, orders, ledger, plan }, null, 2);
    const checksum = createHash("sha256").update(contents).digest("hex");
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    const handle = await open(backupPath, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    if (createHash("sha256").update(await readFile(backupPath)).digest("hex") !== checksum) throw new Error("Backup verification failed.");
    const names = new Map(plan.names.map(item => [item.id, item.name]));
    const changed = new Set([...plan.names.map(row => row.id), ...plan.stock.map(row => row.id)]);
    const updates = products.filter(row => changed.has(row.id)).map(row => ({ id: row.id, revision: row.revision, name: names.get(row.id) || row.data.name }));
    if (updates.length) {
      const result = await client.query(`UPDATE ${table(schema, "products")} AS p SET data=jsonb_set(jsonb_set(p.data,'{stock}',to_jsonb($2::int)),'{name}',to_jsonb(patch.name)),revision=p.revision+1 FROM jsonb_to_recordset($1::jsonb) AS patch(id text,name text,revision integer) WHERE p.id=patch.id AND p.revision=patch.revision`, [JSON.stringify(updates), CATALOG_INITIAL_STOCK]);
      if (result.rowCount !== updates.length) throw new Error("Products changed concurrently. Rolling back.");
    }
    if (plan.adjustments.length) {
      await client.query(`INSERT INTO ${table(schema, "inventory_balances")} (id,branch,"productId","onHand") SELECT id,branch,"productId",target FROM jsonb_to_recordset($1::jsonb) AS patch(id text,branch text,"productId" text,target integer) ON CONFLICT (id) DO UPDATE SET "onHand"=EXCLUDED."onHand"`, [JSON.stringify(plan.adjustments)]);
      await client.query(`INSERT INTO ${table(schema, "ledger_entries")} (branch,kind,"resourceId",delta,reference,"actorId",reason) SELECT branch,'stock',"productId",delta,$2||':'||branch||':'||"productId",$3,$4 FROM jsonb_to_recordset($1::jsonb) AS patch(branch text,"productId" text,delta bigint) WHERE delta<>0`, [JSON.stringify(plan.adjustments),CATALOG_REFRESH_VERSION,ACTOR,"Đặt tồn ban đầu 100 theo yêu cầu chủ hệ thống"]);
    }
    const after = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id`)).rows;
    const protectedFields = row => { const { name, stock, ...data } = row.data; const { revision, ...rest } = row; return { ...rest, data }; };
    if (JSON.stringify(products.map(protectedFields)) !== JSON.stringify(after.map(protectedFields))) throw new Error("Product fields other than name and stock changed. Rolling back.");
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, [ACTOR,"catalog-stock-name-refresh",CATALOG_REFRESH_VERSION,JSON.stringify({ backupPath,checksum,summary:plan.summary,names:plan.names,adjustments:plan.adjustments })]);
    await client.query("COMMIT");
    return { applied: true, alreadyApplied: false, summary: plan.summary, names: plan.names, backupPath, checksum };
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
    const result = await refreshCatalog(client, schema, { apply: process.argv.includes("--apply"), backupPath: resolve("backups/catalog-refresh", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`) });
    console.log(JSON.stringify({ stage: result.applied ? "applied" : "preview", alreadyApplied:result.alreadyApplied,...result.summary,names:result.names?.slice(0,12),backupPath:result.backupPath }, null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Catalog refresh stopped: ${error.message}`); process.exitCode=1; });
