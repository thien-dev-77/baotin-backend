import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import "reflect-metadata";
import EmbeddedPostgres from "embedded-postgres";
import { cleanupMockCatalog, restoreMockCatalog } from "../scripts/cleanup-mock-catalog.mjs";

test("mock cleanup backs up, protects real data, suppresses reseeding and restores", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-cleanup-qa-"));
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password: "MockCleanup-QA-password", port, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let client;
  try {
    await database.initialise();
    await database.start();
    client = database.getPgClient("postgres", "127.0.0.1");
    await client.connect();
    const schema = "cleanup_qa";
    await client.query(`CREATE SCHEMA ${schema}`);
    const definitions = {
      products: "id text PRIMARY KEY, slug text, data jsonb, published boolean DEFAULT true",
      categories: "slug text PRIMARY KEY, data jsonb",
      orders: "id text PRIMARY KEY, data jsonb, checkout jsonb, \"customerId\" text, \"guestId\" text, \"idempotencyKey\" text",
      approvals: "id text PRIMARY KEY, data jsonb",
      receipts: "id text PRIMARY KEY, data jsonb",
      inventory_balances: "id text PRIMARY KEY, \"productId\" text, \"onHand\" integer",
      ledger_entries: "id text PRIMARY KEY, kind text, \"resourceId\" text, reference text, delta bigint",
      integration_links: "id text PRIMARY KEY, kind text, \"localId\" text",
      integration_outbox: "\"orderId\" text PRIMARY KEY",
      product_reviews: "id text PRIMARY KEY, \"productId\" text",
      price_policies: "id uuid PRIMARY KEY, data jsonb, revision integer DEFAULT 1",
      users: "id text PRIMARY KEY, profile jsonb, revision integer DEFAULT 1",
      notifications: "id text PRIMARY KEY, \"eventKey\" text",
      content_entries: "id text PRIMARY KEY, data jsonb, published boolean, revision integer DEFAULT 1, \"updatedAt\" timestamptz DEFAULT now()",
      audit_events: "id uuid DEFAULT gen_random_uuid(), \"actorId\" text, action text, \"resourceId\" text, detail jsonb",
    };
    for (const [name, definition] of Object.entries(definitions)) await client.query(`CREATE TABLE ${schema}.${name} (${definition})`);
    const fixture = {
      products: [{ id: "MOCK", slug: "mock", code: "MOCK", category: "mock-category", stock: 5 }],
      categories: [{ slug: "mock-category", name: "Mock category" }],
      orders: [{ id: "MOCK-ORDER", customerId: "CUSTOMER", items: [{ productId: "MOCK", quantity: 1 }] }],
      approvals: [{ id: "MOCK-APPROVAL", orderId: "MOCK-ORDER" }],
    };
    const seed = async () => {
      await client.query(`INSERT INTO ${schema}.products VALUES ('MOCK', 'mock', $1, true) ON CONFLICT DO NOTHING`, [JSON.stringify(fixture.products[0])]);
      await client.query(`INSERT INTO ${schema}.categories VALUES ('mock-category', $1) ON CONFLICT DO NOTHING`, [JSON.stringify(fixture.categories[0])]);
      await client.query(`INSERT INTO ${schema}.orders (id,data,\"customerId\") VALUES ('MOCK-ORDER', $1, 'CUSTOMER') ON CONFLICT DO NOTHING`, [JSON.stringify({ ...fixture.orders[0], details: { note: "Seed" } })]);
      await client.query(`INSERT INTO ${schema}.approvals VALUES ('MOCK-APPROVAL', $1) ON CONFLICT DO NOTHING`, [JSON.stringify(fixture.approvals[0])]);
    };
    await seed();
    await client.query(`INSERT INTO ${schema}.products VALUES ('REAL','real',$1,true)`, [JSON.stringify({ id: "REAL", code: "REAL", category: "real-category" })]);
    await client.query(`INSERT INTO ${schema}.inventory_balances VALUES ('MOCK-BALANCE','MOCK',4)`);
    await client.query(`INSERT INTO ${schema}.ledger_entries VALUES ('MOCK-LEDGER','stock','MOCK','order:MOCK-ORDER:stock:MOCK',-1)`);
    await client.query(`INSERT INTO ${schema}.users (id,profile) VALUES ('USER',$1)`, [JSON.stringify({ favorites: ["MOCK", "REAL"], company: "Preserved" })]);
    await client.query(`INSERT INTO ${schema}.price_policies (id,data) VALUES ($1,$2)`, ["00000000-0000-4000-8000-000000000001", JSON.stringify({ name: "Bảng giá B2B mẫu", scope: "default", active: true, prices: { MOCK: 100, REAL: 200 } })]);
    await client.query(`INSERT INTO ${schema}.content_entries (id,data,published) VALUES ('BANNER',$1,true)`, [JSON.stringify({ category: "mock-category", href: "/category/mock-category" })]);
    await client.query(`INSERT INTO ${schema}.notifications VALUES ('NOTICE','order:MOCK-ORDER:2')`);
    const count = async name => Number((await client.query(`SELECT count(*) FROM ${schema}.${name}`)).rows[0].count);
    const backupPath = join(directory, "backup.json");
    assert.equal((await cleanupMockCatalog(client, schema, fixture)).applied, false);
    assert.equal(await count("products"), 2);
    await client.query(`INSERT INTO ${schema}.orders (id,data) VALUES ('REAL-ORDER',$1)`, [JSON.stringify({ items: [{ productId: "MOCK" }] })]);
    await assert.rejects(cleanupMockCatalog(client, schema, fixture, { apply: true, backupPath }), /Other orders/);
    assert.equal(await count("products"), 2);
    await client.query(`DELETE FROM ${schema}.orders WHERE id='REAL-ORDER'`);
    await writeFile(backupPath, "existing-backup");
    await assert.rejects(cleanupMockCatalog(client, schema, fixture, { apply: true, backupPath }), /EEXIST/);
    assert.equal(await count("orders"), 1);
    await rm(backupPath);
    const result = await cleanupMockCatalog(client, schema, fixture, { apply: true, backupPath });
    assert.equal(result.applied, true);
    const backupText = await readFile(backupPath, "utf8");
    assert.equal(JSON.parse(backupText).tables.products[0].id, "MOCK");
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.equal(await count("products"), 1);
    for (const name of ["orders", "categories", "approvals", "inventory_balances", "ledger_entries", "notifications"]) assert.equal(await count(name), 0, name);
    assert.deepEqual((await client.query(`SELECT profile FROM ${schema}.users`)).rows[0].profile, { favorites: ["REAL"], company: "Preserved" });
    assert.equal((await client.query(`SELECT data FROM ${schema}.price_policies`)).rows[0].data.active, false);
    assert.equal((await client.query(`SELECT published FROM ${schema}.content_entries`)).rows[0].published, false);
    const { SeedService } = createRequire(import.meta.url)("../dist/database/seed.service.js");
    const previousEnv = { SEED_MOCK_DATA: process.env.SEED_MOCK_DATA, NODE_ENV: process.env.NODE_ENV, DB_SCHEMA: process.env.DB_SCHEMA };
    try {
      process.env.SEED_MOCK_DATA = "true";
      process.env.NODE_ENV = "production";
      process.env.DB_SCHEMA = schema;
      await new SeedService({ source: { query: async (sql, params) => (await client.query(sql, params)).rows }, transaction: () => { throw new Error("Seed must not run after cleanup."); } }).onApplicationBootstrap();
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    await seed();
    assert.equal(await count("products"), 1);
    assert.equal(await count("orders"), 0);
    assert.equal(await count("categories"), 0);
    assert.equal(await count("approvals"), 0);
    const repeat = await cleanupMockCatalog(client, schema, fixture);
    assert.equal(Object.values(repeat.counts).every(count => count === 0), true);
    await client.query(`INSERT INTO ${schema}.categories VALUES ('mock-category',$1)`, [JSON.stringify({ slug: "mock-category", name: "Real imported category" })]);
    assert.equal(await count("categories"), 1);
    await assert.rejects(restoreMockCatalog(client, backupText), /overwrite existing categories/);
    await client.query(`DELETE FROM ${schema}.categories`);
    await assert.rejects(restoreMockCatalog(client, backupText.replace("Preserved", "Changed")), /checksum/);
    assert.equal((await restoreMockCatalog(client, backupText)).restored, true);
    assert.equal(await count("products"), 2);
    assert.equal(await count("orders"), 1);
    assert.equal(await count("categories"), 1);
    assert.equal(await count("ledger_entries"), 1);
    assert.deepEqual((await client.query(`SELECT profile FROM ${schema}.users`)).rows[0].profile.favorites, ["MOCK", "REAL"]);
  } finally {
    if (client) await client.end();
    await database.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
