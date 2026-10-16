import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import sharp from "sharp";
import { planHomepageRepair, HOMEPAGE_REPAIR_VERSION } from "../dist/content/homepage-repair.js";
import { assertProductImageExists, resolveProductImagePath } from "../dist/media/product-media.js";

const COMMAND_LOCK = 82610477;
function table(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (!["products", "categories", "content_entries", "audit_events"].includes(name)) throw new Error("Unknown homepage table.");
  return `"${schema}"."${name}"`;
}

export async function repairHomepage(client, schema, { apply = false, backupPath, validateMedia = validateHomepageImages } = {}) {
  table(schema, "products");
  await client.query("BEGIN");
  try {
    if (apply) await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    else await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const lock = apply ? " FOR UPDATE" : "";
    const categories = (await client.query(`SELECT * FROM ${table(schema, "categories")} ORDER BY slug${lock}`)).rows;
    const products = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id${lock}`)).rows;
    const content = (await client.query(`SELECT * FROM ${table(schema, "content_entries")} ORDER BY id${lock}`)).rows;
    const plan = planHomepageRepair(content, products, categories);
    await validateMedia(plan);
    if (!apply || !plan.banners.length && !plan.featured.length) { await client.query("ROLLBACK"); return { applied: false, plan, backupPath: null }; }
    if (!backupPath) throw new Error("A new backup path is required before applying changes.");
    const contents = JSON.stringify({ version: HOMEPAGE_REPAIR_VERSION, at: new Date().toISOString(), schema, categories, products, content, plan }, null, 2);
    const checksum = createHash("sha256").update(contents).digest("hex");
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    const handle = await open(backupPath, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    if (createHash("sha256").update(await readFile(backupPath)).digest("hex") !== checksum) throw new Error("Backup verification failed.");
    for (const row of plan.banners) {
      const result = await client.query(`UPDATE ${table(schema, "content_entries")} SET data=$2::jsonb,published=true,revision=revision+1,"updatedAt"=now() WHERE id=$1 AND revision=$3`, [row.id, JSON.stringify(row.data), row.revision]);
      if (result.rowCount !== 1) throw new Error(`Banner changed concurrently: ${row.id}.`);
    }
    for (const row of plan.featured) {
      const result = await client.query(`UPDATE ${table(schema, "products")} SET data=jsonb_set(data,'{featured}','true'::jsonb),revision=revision+1 WHERE id=$1 AND revision=$2 AND published=true`, [row.id, row.revision]);
      if (result.rowCount !== 1) throw new Error(`Product changed concurrently: ${row.data.code}.`);
    }
    const after = (await client.query(`SELECT * FROM ${table(schema, "products")} ORDER BY id`)).rows;
    const unchangedFields = row => { const { featured, ...data } = row.data; const { revision, ...rest } = row; return { ...rest, data }; };
    if (JSON.stringify(products.map(unchangedFields)) !== JSON.stringify(after.map(unchangedFields))) throw new Error("Product fields other than featured changed. Rolling back.");
    await client.query(`INSERT INTO ${table(schema, "audit_events")} ("actorId",action,"resourceId",detail) VALUES ($1,$2,$3,$4::jsonb)`, ["maintenance:homepage", "homepage-repair", HOMEPAGE_REPAIR_VERSION, JSON.stringify({ backupPath, checksum, summary: plan.summary, banners: plan.banners.map(row => row.id), products: plan.selected })]);
    await client.query("COMMIT");
    return { applied: true, plan, backupPath, checksum };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function validateHomepageImages(plan) {
  for (const row of plan.featured) await assertProductImageExists(row.data.image);
  for (const row of plan.banners) {
    const image = await resolveProductImagePath(row.data.image);
    const metadata = await sharp(image).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Invalid banner image: ${row.id}.`);
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
    const result = await repairHomepage(client, schema, { apply: process.argv.includes("--apply"), backupPath: resolve("backups/homepage", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`) });
    console.log(JSON.stringify({ stage: result.applied ? "applied" : "preview", ...result.plan.summary, banners: result.plan.banners.map(row => ({ id: row.id, title: row.data.title, href: row.data.href })), featured: result.plan.selected, backupPath: result.backupPath }, null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`Homepage repair stopped: ${error.message}`); process.exitCode = 1; });
