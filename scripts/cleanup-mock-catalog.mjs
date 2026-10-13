import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";

export const CLEANUP_KEY = "mock-catalog-v1";
const COMMAND_LOCK = 82610477;
const TABLES = ["products", "categories", "orders", "approvals", "receipts", "inventory_balances", "ledger_entries", "integration_links", "integration_outbox", "product_reviews", "price_policies", "users", "notifications", "content_entries"];
const SAMPLE_POLICY_IDS = [1, 2, 3].map(index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);

export function schemaTable(schema, name) {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) throw new Error("Use a dedicated application schema.");
  if (![...TABLES, "mock_seed_cleanup", "audit_events"].includes(name)) throw new Error("Unknown maintenance table.");
  return `"${schema}"."${name}"`;
}

export async function snapshotCatalog(client, schema, fixture) {
  const table = name => schemaTable(schema, name);
  const productIds = fixture.products.map(item => item.id);
  const categorySlugs = fixture.categories.map(item => item.slug);
  const orderIds = fixture.orders.map(item => item.id);
  const query = async (sql, values) => (await client.query(sql, values)).rows;
  const snapshot = {};
  snapshot.products = await query(`SELECT * FROM ${table("products")} WHERE id = ANY($1::text[])`, [productIds]);
  snapshot.categories = await query(`SELECT * FROM ${table("categories")} WHERE slug = ANY($1::text[])`, [categorySlugs]);
  snapshot.orders = await query(`SELECT * FROM ${table("orders")} WHERE id = ANY($1::text[])`, [orderIds]);
  snapshot.approvals = await query(`SELECT * FROM ${table("approvals")} WHERE data->>'orderId' = ANY($1::text[])`, [orderIds]);
  snapshot.receipts = await query(`SELECT * FROM ${table("receipts")} WHERE data->>'orderId' = ANY($1::text[])`, [orderIds]);
  snapshot.inventory_balances = await query(`SELECT * FROM ${table("inventory_balances")} WHERE "productId" = ANY($1::text[])`, [productIds]);
  snapshot.ledger_entries = await query(`SELECT * FROM ${table("ledger_entries")} WHERE (kind = 'stock' AND "resourceId" = ANY($1::text[])) OR (reference LIKE 'order:%' AND split_part(reference, ':', 2) = ANY($2::text[]))`, [productIds, orderIds]);
  snapshot.integration_links = await query(`SELECT * FROM ${table("integration_links")} WHERE (kind = 'product' AND "localId" = ANY($1::text[])) OR (kind = 'order' AND "localId" = ANY($2::text[]))`, [productIds, orderIds]);
  snapshot.integration_outbox = await query(`SELECT * FROM ${table("integration_outbox")} WHERE "orderId" = ANY($1::text[])`, [orderIds]);
  snapshot.product_reviews = await query(`SELECT * FROM ${table("product_reviews")} WHERE "productId" = ANY($1::text[])`, [productIds]);
  snapshot.price_policies = await query(`SELECT * FROM ${table("price_policies")} WHERE (id::text = ANY($1::text[]) AND data->>'active' = 'true' AND data->>'name' = 'Bảng giá B2B mẫu' AND data->>'scope' = 'default') OR data->'prices' ?| $2::text[]`, [SAMPLE_POLICY_IDS, productIds]);
  snapshot.users = await query(`SELECT id, profile, revision FROM ${table("users")} WHERE profile->'favorites' ?| $1::text[]`, [productIds]);
  snapshot.notifications = await query(`SELECT * FROM ${table("notifications")} WHERE split_part("eventKey", ':', 1) IN ('order', 'approval') AND split_part("eventKey", ':', 2) = ANY($1::text[])`, [[...orderIds, ...snapshot.approvals.map(item => item.id)]]);
  snapshot.content_entries = await query(`SELECT * FROM ${table("content_entries")} WHERE published = true AND (data->>'category' = ANY($1::text[]) OR split_part(data->>'href', '?', 1) = ANY($2::text[]))`, [categorySlugs, categorySlugs.map(slug => `/category/${slug}`)]);

  const externalOrders = await query(`SELECT DISTINCT o.id FROM ${table("orders")} o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'items', '[]'::jsonb) || COALESCE(o.checkout->'items', '[]'::jsonb)) item WHERE item->>'productId' = ANY($1::text[]) AND NOT (o.id = ANY($2::text[]))`, [productIds, orderIds]);
  const externalProducts = await query(`SELECT id FROM ${table("products")} WHERE NOT (id = ANY($1::text[])) AND (data->>'category' = ANY($2::text[]) OR data->>'variantGroupId' = ANY($1::text[]))`, [productIds, categorySlugs]);
  const externalApprovals = await query(`SELECT id FROM ${table("orders")} WHERE NOT (id = ANY($1::text[])) AND data->>'approvalId' = ANY($2::text[])`, [orderIds, snapshot.approvals.map(item => item.id)]);
  const blockers = [];
  if (externalOrders.length) blockers.push("Other orders use mock products.");
  if (externalProducts.length) blockers.push("Other products use mock categories or variant groups.");
  if (externalApprovals.length) blockers.push("Other orders use approvals selected for cleanup.");
  if (snapshot.receipts.length || snapshot.ledger_entries.some(item => item.kind === "credit")) blockers.push("Payment or credit records require separate reconciliation.");
  if (snapshot.integration_links.length || snapshot.integration_outbox.length) blockers.push("External integration records require separate reconciliation.");
  const originals = new Map(fixture.products.map(item => [item.id, item]));
  if (snapshot.products.some(row => row.slug !== originals.get(row.id).slug || row.data.code !== originals.get(row.id).code)) blockers.push("A fixture product identity has changed.");
  const originalOrders = new Map(fixture.orders.map(item => [item.id, item]));
  if (snapshot.orders.some(row => row.checkout || row.guestId || row.idempotencyKey || row.customerId !== originalOrders.get(row.id).customerId)) blockers.push("A fixture order has a real checkout or different customer identity.");
  if (snapshot.ledger_entries.some(row => row.kind === "stock" && !orderIds.some(id => row.reference.startsWith(`order:${id}:stock:`)))) blockers.push("Stock entries are not attributable to fixture orders.");
  return { snapshot, blockers, counts: Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [name, rows.length])) };
}

// A database guard also handles older deployments that still seed on startup.
export async function installSeedGuard(client, schema, fixture) {
  const guard = schemaTable(schema, "mock_seed_cleanup");
  await client.query(`CREATE TABLE IF NOT EXISTS ${guard} (id text PRIMARY KEY, fixture jsonb NOT NULL, "completedAt" timestamptz NOT NULL DEFAULT now())`);
  await client.query(`INSERT INTO ${guard} (id, fixture) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING`, [CLEANUP_KEY, JSON.stringify({ products: fixture.products, categories: fixture.categories, orders: fixture.orders, approvals: fixture.approvals })]);
  await client.query(`
    CREATE OR REPLACE FUNCTION "${schema}".suppress_cleaned_mock_seed() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE payload jsonb; incoming jsonb := to_jsonb(NEW);
    BEGIN
      SELECT fixture INTO payload FROM ${guard} WHERE id = '${CLEANUP_KEY}';
      IF payload IS NULL THEN RETURN NEW; END IF;
      IF TG_TABLE_NAME = 'products' AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'products') item WHERE item->>'id' = incoming->>'id' AND item = incoming->'data') THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME = 'categories' AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'categories') item WHERE item->>'slug' = incoming->>'slug' AND item = incoming->'data') THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME = 'orders' AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'orders') item WHERE item->>'id' = incoming->>'id' AND item = ((incoming->'data') - 'details')) THEN RETURN NULL; END IF;
      IF TG_TABLE_NAME = 'approvals' AND EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'approvals') item WHERE item->>'id' = incoming->>'id' AND item = incoming->'data') THEN RETURN NULL; END IF;
      RETURN NEW;
    END $body$;
  `);
  for (const name of ["products", "categories", "orders", "approvals"]) {
    const table = schemaTable(schema, name);
    await client.query(`DROP TRIGGER IF EXISTS suppress_cleaned_mock_seed ON ${table}`);
    await client.query(`CREATE TRIGGER suppress_cleaned_mock_seed BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION "${schema}".suppress_cleaned_mock_seed()`);
  }
}

export async function cleanupMockCatalog(client, schema, fixture, { apply = false, backupPath } = {}) {
  const table = name => schemaTable(schema, name);
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    if (apply) {
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
      await client.query(`LOCK TABLE ${TABLES.map(table).join(", ")} IN SHARE ROW EXCLUSIVE MODE`);
    }
    const plan = await snapshotCatalog(client, schema, fixture);
    if (!apply) { await client.query("ROLLBACK"); return { counts: plan.counts, blockers: plan.blockers, applied: false }; }
    if (plan.blockers.length) throw new Error(plan.blockers.join(" "));
    if (!backupPath) throw new Error("A backup path is required before deletion.");
    const backup = JSON.stringify({ version: 1, schema, at: new Date().toISOString(), counts: plan.counts, tables: plan.snapshot }, null, 2);
    const checksum = createHash("sha256").update(backup).digest("hex");
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    const file = await open(backupPath, "wx", 0o600);
    try { await file.writeFile(backup); await file.sync(); } finally { await file.close(); }
    if (createHash("sha256").update(await readFile(backupPath)).digest("hex") !== checksum) throw new Error("Backup verification failed.");
    await installSeedGuard(client, schema, fixture);
    const productIds = new Set(fixture.products.map(item => item.id));
    for (const row of plan.snapshot.users) {
      const profile = { ...row.profile, favorites: row.profile.favorites.filter(id => !productIds.has(id)) };
      await client.query(`UPDATE ${table("users")} SET profile = $1::jsonb, revision = revision + 1 WHERE id = $2`, [JSON.stringify(profile), row.id]);
    }
    for (const row of plan.snapshot.price_policies) {
      const prices = Object.fromEntries(Object.entries(row.data.prices || {}).filter(([id]) => !productIds.has(id)));
      const sample = SAMPLE_POLICY_IDS.includes(row.id) && row.data.name === "Bảng giá B2B mẫu" && row.data.scope === "default";
      await client.query(`UPDATE ${table("price_policies")} SET data = $1::jsonb, revision = revision + 1 WHERE id = $2`, [JSON.stringify({ ...row.data, prices, ...(sample ? { active: false } : {}) }), row.id]);
    }
    for (const row of plan.snapshot.content_entries) await client.query(`UPDATE ${table("content_entries")} SET published = false, revision = revision + 1, "updatedAt" = now() WHERE id = $1`, [row.id]);
    for (const name of ["notifications", "product_reviews", "approvals", "ledger_entries", "inventory_balances", "orders", "products", "categories"]) {
      const key = name === "categories" ? "slug" : "id";
      await client.query(`DELETE FROM ${table(name)} WHERE "${key}"::text = ANY($1::text[])`, [plan.snapshot[name].map(row => row[key])]);
    }
    for (const [name, ids, key] of [["products", [...productIds], "id"], ["orders", fixture.orders.map(item => item.id), "id"], ["categories", fixture.categories.map(item => item.slug), "slug"]]) {
      const remaining = await client.query(`SELECT count(*)::int AS count FROM ${table(name)} WHERE "${key}" = ANY($1::text[])`, [ids]);
      if (remaining.rows[0].count !== 0) throw new Error(`Cleanup verification failed for ${name}.`);
    }
    await client.query(`INSERT INTO ${table("audit_events")} ("actorId", action, "resourceId", detail) VALUES ($1, $2, $3, $4::jsonb)`, ["maintenance:mock-catalog", "mock-catalog-cleanup", CLEANUP_KEY, JSON.stringify({ backupPath, checksum, counts: plan.counts })]);
    await client.query("COMMIT");
    return { counts: plan.counts, applied: true, backupPath, checksum, seedSuppressed: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function restoreMockCatalog(client, backupText) {
  const backup = JSON.parse(backupText);
  if (backup.version !== 1 || !backup.tables) throw new Error("Unsupported backup.");
  const table = name => schemaTable(backup.schema, name);
  const checksum = createHash("sha256").update(backupText).digest("hex");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [COMMAND_LOCK]);
    await client.query(`LOCK TABLE ${TABLES.map(table).join(", ")} IN SHARE ROW EXCLUSIVE MODE`);
    const audit = await client.query(`SELECT id FROM ${table("audit_events")} WHERE action = 'mock-catalog-cleanup' AND detail->>'checksum' = $1`, [checksum]);
    if (!audit.rowCount) throw new Error("The backup checksum has no matching cleanup audit.");
    const deletedTables = ["products", "categories", "orders", "approvals", "inventory_balances", "ledger_entries", "product_reviews", "notifications"];
    for (const name of deletedTables) {
      const key = name === "categories" ? "slug" : "id";
      const ids = backup.tables[name].map(row => row[key]);
      const conflict = await client.query(`SELECT 1 FROM ${table(name)} WHERE "${key}"::text = ANY($1::text[]) LIMIT 1`, [ids]);
      if (conflict.rowCount) throw new Error(`Restore would overwrite existing ${name}.`);
    }
    for (const name of ["users", "price_policies", "content_entries"]) {
      for (const row of backup.tables[name]) {
        const current = await client.query(`SELECT revision FROM ${table(name)} WHERE id = $1`, [row.id]);
        if (current.rows[0]?.revision !== row.revision + 1) throw new Error(`A ${name} record has changed since cleanup.`);
      }
    }
    await client.query(`DELETE FROM ${table("mock_seed_cleanup")} WHERE id = $1`, [CLEANUP_KEY]);
    for (const name of deletedTables) {
      if (backup.tables[name].length) await client.query(`INSERT INTO ${table(name)} SELECT * FROM jsonb_populate_recordset(NULL::${table(name)}, $1::jsonb)`, [JSON.stringify(backup.tables[name])]);
    }
    for (const row of backup.tables.users) await client.query(`UPDATE ${table("users")} SET profile = $1::jsonb, revision = $2 WHERE id = $3`, [JSON.stringify(row.profile), row.revision, row.id]);
    for (const row of backup.tables.price_policies) await client.query(`UPDATE ${table("price_policies")} SET data = $1::jsonb, revision = $2 WHERE id = $3`, [JSON.stringify(row.data), row.revision, row.id]);
    for (const row of backup.tables.content_entries) await client.query(`UPDATE ${table("content_entries")} SET data = $1::jsonb, published = $2, revision = $3, "updatedAt" = $4 WHERE id = $5`, [JSON.stringify(row.data), row.published, row.revision, row.updatedAt, row.id]);
    for (const name of ["products", "categories", "orders", "approvals"]) await client.query(`DROP TRIGGER IF EXISTS suppress_cleaned_mock_seed ON ${table(name)}`);
    await client.query(`DROP FUNCTION IF EXISTS "${backup.schema}".suppress_cleaned_mock_seed()`);
    await client.query(`INSERT INTO ${table("audit_events")} ("actorId", action, "resourceId", detail) VALUES ($1, $2, $3, $4::jsonb)`, ["maintenance:mock-catalog", "mock-catalog-restore", CLEANUP_KEY, JSON.stringify({ checksum })]);
    await client.query("COMMIT");
    return { restored: true, counts: backup.counts };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  config({ path: process.env.ENV_FILE || ".env", quiet: true });
  const fixture = JSON.parse(await readFile(new URL("../seed/mock.json", import.meta.url), "utf8"));
  const schema = process.env.DB_SCHEMA || "baotin_app";
  schemaTable(schema, "products");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) } : false;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis: 7000 });
  await client.connect();
  try {
    const apply = process.argv.includes("--apply");
    const restoreIndex = process.argv.indexOf("--restore");
    if (restoreIndex !== -1) {
      if (!apply || !process.argv[restoreIndex + 1]) throw new Error("Restore requires --restore BACKUP_PATH --apply.");
      const backupText = await readFile(resolve(process.argv[restoreIndex + 1]), "utf8");
      if (JSON.parse(backupText).schema !== schema) throw new Error("The backup schema does not match DB_SCHEMA.");
      console.log(JSON.stringify(await restoreMockCatalog(client, backupText), null, 2));
      return;
    }
    const backupPath = resolve("backups", `mock-catalog-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    console.log(JSON.stringify(await cleanupMockCatalog(client, schema, fixture, { apply, backupPath }), null, 2));
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(`Mock cleanup stopped: ${error.message}`);
  process.exitCode = 1;
});
