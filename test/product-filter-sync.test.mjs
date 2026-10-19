import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { planProductFilterSync, syncProductFilterAttributes } from "../scripts/sync-product-filter-attributes.mjs";
import { readHafeleCatalog, hafeleCatalogChecksum } from "../scripts/import-hafele.mjs";

config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Sync QA only targets local PostgreSQL.");

test("Sync is selective, idempotent, backed up and atomic on local PostgreSQL", async () => {
  const schema = `facet_sync_qa_${randomBytes(6).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "baotin-facet-sync-"));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`CREATE TABLE "${schema}".products (id text PRIMARY KEY,slug text,data jsonb,published boolean,revision integer)`);
    await client.query(`CREATE TABLE "${schema}".categories (slug text PRIMARY KEY,data jsonb,revision integer)`);
    await client.query(`CREATE TABLE "${schema}".audit_events ("actorId" text,action text,"resourceId" text,detail jsonb)`);
    const products = [
      { id: "qa-a", code: "A", brand: "HAFELE", material: "Inox 304 / ABS", color: "Đen mờ", origin: "Germany", price: 12345, gallery: ["/media/uploads/qa.webp"], variantGroupId: "qa-group" },
      { id: "qa-b", code: "B", brand: "Fulco", material: "Nhựa", materialGroups: ["steel"], color: "", origin: "", stock: 100 },
      { id: "qa-c", code: "C", brand: "Fulco", material: "", color: "", origin: "" },
    ];
    for (const product of products) await client.query(`INSERT INTO "${schema}".products VALUES ($1,$1,$2,false,7)`, [product.id, product]);
    await client.query(`INSERT INTO "${schema}".categories VALUES ('qa', '{"name":"QA"}', 3)`);
    const before = await readHafeleCatalog(client, schema);
    const plan = planProductFilterSync(before.products);
    assert.equal(plan.total, 3); assert.equal(plan.updated, 1);
    assert.equal(plan.fields.material.manualPreserved, 1);
    assert.deepEqual(plan.changes[0].patch, { materialGroups: ["inox-304", "plastic"], colorGroups: ["black"], originGroups: ["germany"] });
    const preview = await syncProductFilterAttributes(client, schema);
    assert.equal(preview.applied, false);
    assert.deepEqual(await readHafeleCatalog(client, schema), before);
    await assert.rejects(syncProductFilterAttributes(client, schema, { apply: true, expectedChecksum: "stale", backupPath: join(directory, "stale.json") }), /Catalog changed/);
    const backupPath = join(directory, "before.json");
    const applied = await syncProductFilterAttributes(client, schema, { apply: true, expectedChecksum: preview.checksum, backupPath });
    assert.equal(applied.applied, true); assert.equal(applied.updated, 1);
    const backup = JSON.parse(await readFile(backupPath, "utf8"));
    assert.deepEqual(backup.products, before.products); assert.deepEqual(backup.categories, before.categories);
    const after = await readHafeleCatalog(client, schema);
    assert.deepEqual(after.categories, before.categories);
    assert.deepEqual(after.products, before.products.map(row => row.id === "qa-a" ? { ...row, revision: 8, data: { ...row.data, ...plan.changes[0].patch } } : row));
    assert.equal((await syncProductFilterAttributes(client, schema, { apply: true })).updated, 0);
    assert.deepEqual(await readHafeleCatalog(client, schema), after);

    await client.query(`UPDATE "${schema}".products SET data=data-'colorGroups' WHERE id='qa-a'`);
    const rollbackBefore = await readHafeleCatalog(client, schema);
    const failing = { query: (query, parameters) => {
      if (query.startsWith(`INSERT INTO "${schema}"."audit_events"`)) throw new Error("QA audit failure");
      return client.query(query, parameters);
    } };
    await assert.rejects(syncProductFilterAttributes(failing, schema, { apply: true, expectedChecksum: hafeleCatalogChecksum(rollbackBefore), backupPath: join(directory, "rollback.json") }), /QA audit failure/);
    assert.deepEqual(await readHafeleCatalog(client, schema), rollbackBefore);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM "${schema}".audit_events`)).rows[0].count, 1);
  } finally {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end(); await rm(directory, { recursive: true, force: true });
  }
});
