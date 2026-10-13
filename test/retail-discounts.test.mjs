import test from "node:test";
import assert from "node:assert/strict";
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { resetRetailDiscounts, retailPricingChanges } from "../scripts/reset-retail-discounts.mjs";
import { defaultB2bPrice, publicProduct } from "../dist/catalog/product-pricing.js";

const products = [60, 65].map((discount, index) => ({
  id: `QA-${index}`, slug: `qa-${index}`, published: index === 0, revision: 3,
  data: { id: `QA-${index}`, code: `FC-${index}`, name: "QA Product", listPrice: 100000, b2cDiscount: discount, b2bDiscount: discount, price: 100000 * (1 - discount / 100), oldPrice: 100000, stock: 100, gallery: ["/media/uploads/qa.webp"], category: "qa", variantGroupId: "QA-0", featured: true },
}));

test("Retail reset uses canonical pricing, validates all products and does not mutate the input", () => {
  const before = structuredClone(products);
  const changes = retailPricingChanges(products);
  assert.equal(changes.length, 2);
  assert.ok(changes.every(change => change.price === 100000));
  assert.deepEqual(products, before);
  const cleared = products.map(row => { const { oldPrice, ...data } = row.data; return { ...row, data: { ...data, b2cDiscount: 0, price: 100000 } }; });
  assert.deepEqual(retailPricingChanges(cleared), []);
  assert.throws(() => retailPricingChanges([...products, { ...products[0], data: { price: 40000 } }]), /Nhập đủ/);
  assert.throws(() => retailPricingChanges([{ ...products[0], data: { ...products[0].data, listPrice: -1 } }]), /không hợp lệ/);
});

test("Retail reset backs up first, retains B2B and non-catalog data, and is one-time", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-retail-qa-"));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password: "RetailPricing-QA-password", port, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let client;
  try {
    await database.initialise(); await database.start();
    client = database.getPgClient("postgres", "127.0.0.1"); await client.connect();
    const schema = "retail_qa";
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.products (id text PRIMARY KEY, slug text UNIQUE, data jsonb, published boolean, revision integer NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.audit_events (id uuid DEFAULT gen_random_uuid(), "actorId" text, action text, "resourceId" text, detail jsonb, at timestamptz DEFAULT now())`);
    for (const name of ["orders", "inventory_balances", "price_policies"]) {
      await client.query(`CREATE TABLE ${schema}.${name} (id text PRIMARY KEY, data jsonb)`);
      await client.query(`INSERT INTO ${schema}.${name} VALUES ('QA', $1)`, [JSON.stringify({ total: 40000, stock: 100, discount: 60, approved: true })]);
    }
    const read = async () => (await client.query(`SELECT * FROM ${schema}.products ORDER BY id`)).rows;
    const unrelated = async () => {
      const snapshots = [];
      for (const name of ["orders", "inventory_balances", "price_policies"]) snapshots.push((await client.query(`SELECT * FROM ${schema}.${name} ORDER BY id`)).rows);
      return snapshots;
    };
    await client.query(`INSERT INTO ${schema}.products SELECT id,slug,data,published,revision FROM jsonb_to_recordset($1::jsonb) AS p(id text,slug text,data jsonb,published boolean,revision integer)`, [JSON.stringify(products)]);
    const before = await read();
    const untouched = await unrelated();
    const preview = await resetRetailDiscounts(client, schema);
    assert.equal(preview.applied, false); assert.equal(preview.summary.updated, 2);
    assert.deepEqual(await read(), before);
    const backupPath = join(directory, "backup.json");
    await assert.rejects(resetRetailDiscounts(client, schema, { apply: true }), /backup path/);
    await writeFile(backupPath, "existing backup");
    await assert.rejects(resetRetailDiscounts(client, schema, { apply: true, backupPath }), /EEXIST/);
    assert.deepEqual(await read(), before);
    await rm(backupPath);
    const result = await resetRetailDiscounts(client, schema, { apply: true, backupPath });
    assert.equal(result.applied, true); assert.equal(result.summary.updated, 2);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(backupPath, "utf8")).products, before);
    const after = await read();
    for (let index = 0; index < after.length; index++) {
      const { oldPrice, ...previousData } = before[index].data;
      assert.deepEqual(after[index], { ...before[index], revision: before[index].revision + 1, data: { ...previousData, b2cDiscount: 0, price: previousData.listPrice } });
      assert.equal(defaultB2bPrice(after[index].data), defaultB2bPrice(before[index].data));
      assert.equal(publicProduct(after[index].data).price, previousData.listPrice);
      assert.equal(publicProduct(after[index].data).oldPrice, undefined);
      assert.ok(!("b2bDiscount" in publicProduct(after[index].data)));
    }
    assert.deepEqual(await unrelated(), untouched);
    await client.query(`UPDATE ${schema}.products SET data=data||'{"b2cDiscount":10,"price":90000,"oldPrice":100000}'::jsonb WHERE id='QA-0'`);
    const repeated = await resetRetailDiscounts(client, schema, { apply: true, backupPath });
    assert.equal(repeated.alreadyApplied, true);
    assert.equal((await read())[0].data.b2cDiscount, 10);
    assert.equal((await client.query(`SELECT count(*) FROM ${schema}.audit_events`)).rows[0].count, "1");
  } finally {
    if (client) await client.end();
    await database.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
