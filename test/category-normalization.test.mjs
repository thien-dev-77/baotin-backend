import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { FULCO_CATEGORIES } from "../dist/catalog/fulco-taxonomy.js";
import { normalizeFulcoCategories } from "../scripts/normalize-fulco-categories.mjs";

config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Taxonomy QA only targets local PostgreSQL.");

test("Taxonomy apply requires verified backup, preserves product data, and is idempotent", async () => {
  const schema = `taxonomy_qa_${randomBytes(6).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "baotin-taxonomy-"));
  const backupPath = join(directory, "snapshot.json");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`CREATE TABLE "${schema}".categories (slug text PRIMARY KEY, data jsonb NOT NULL, revision int NOT NULL)`);
    await client.query(`CREATE TABLE "${schema}".products (id text PRIMARY KEY, slug text NOT NULL, data jsonb NOT NULL, published boolean NOT NULL, revision int NOT NULL)`);
    await client.query(`CREATE TABLE "${schema}".audit_events ("actorId" text, action text, "resourceId" text, detail jsonb)`);
    for (const definition of FULCO_CATEGORIES.filter(item => item.existing)) await client.query(`INSERT INTO "${schema}".categories VALUES ($1,$2,2)`, [definition.slug, { slug: definition.slug, name: definition.slug, image: "/images/catalog/kitchen.png", description: "Existing description", subcategories: [], visible: true, sortOrder: 0 }]);
    const data = { id: "QA", slug: "qa", code: "F11", category: "chau-voi-rua-bat", image: "/images/catalog/kitchen.png", gallery: ["/images/catalog/kitchen.png"], price: 100000, listPrice: 250000, b2cDiscount: 60, b2bDiscount: 65, stock: 42, variantGroupId: "QA", variantAttributes: [{ name: "Màu", value: "Trắng" }] };
    await client.query(`INSERT INTO "${schema}".products VALUES ('QA','qa',$1,false,3)`, [data]);
    const before = (await client.query(`SELECT * FROM "${schema}".products`)).rows;
    const preview = await normalizeFulcoCategories(client, schema);
    assert.equal(preview.applied, false);
    assert.equal(preview.summary.productsReassigned, 1);
    assert.equal((await client.query(`SELECT COUNT(*) FROM "${schema}".categories`)).rows[0].count, "28");
    await assert.rejects(normalizeFulcoCategories(client, schema, { apply: true }), /backup path/);
    await writeFile(backupPath, "existing backup");
    await assert.rejects(normalizeFulcoCategories(client, schema, { apply: true, backupPath }), /EEXIST/);
    assert.deepEqual((await client.query(`SELECT * FROM "${schema}".products`)).rows, before);
    await rm(backupPath);
    const result = await normalizeFulcoCategories(client, schema, { apply: true, backupPath });
    assert.equal(result.applied, true);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(backupPath, "utf8")).products, before);
    const after = (await client.query(`SELECT * FROM "${schema}".products`)).rows[0];
    assert.deepEqual(after.data, { ...data, category: "voi-rua" });
    assert.equal(after.published, false);
    assert.equal(after.revision, 4);
    const repeated = await normalizeFulcoCategories(client, schema, { apply: true, backupPath });
    assert.equal(repeated.applied, false);
    assert.equal(repeated.categories.length, 0);
    assert.equal((await client.query(`SELECT COUNT(*) FROM "${schema}".audit_events`)).rows[0].count, "1");
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); await rm(directory, { recursive: true, force: true }); }
});
