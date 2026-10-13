import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { HOMEPAGE_FEATURED_CODES, planHomepageRepair } from "../dist/content/homepage-repair.js";
import { repairHomepage } from "../scripts/repair-homepage.mjs";

const categories = ["phu-kien-tu-bep", "phu-kien-tu-bep-duoi", "phu-kien-tu-bep-tren"].map((slug, index) => ({ slug, revision: 1, data: { slug, name: slug, parentSlug: index ? "phu-kien-tu-bep" : "", visible: true } }));
const products = HOMEPAGE_FEATURED_CODES.map(code => ({ id: code, slug: code.toLowerCase(), revision: 3, published: true, data: { id: code, slug: code.toLowerCase(), code, name: `Sản phẩm ${code}`, category: "phu-kien-tu-bep-duoi", brand: "Fulco", unit: "bộ", specification: "Inox", image: "/images/catalog/kitchen.png", gallery: ["/images/catalog/kitchen.png"], price: 100000, listPrice: 250000, b2cDiscount: 60, b2bDiscount: 65, stock: 0, featured: false } }));
const content = [
  ["phu-kien-bep", "kitchen-lighting-hd.jpg"], ["led-tu-ke", "cabinet-lighting-hd.jpg"], ["phu-kien-lap-dat", "wood-kitchen-hd.jpg"],
].map(([category, image], index) => ({ id: `banner:banner-${index + 1}`, kind: "banner", published: false, revision: 2, data: { slug: `banner-${index + 1}`, title: "Old title", category, image: `/images/hero/${image}`, href: `/category/${category}`, width: 3750, height: 1250, position: index } }));

test("Plan restores cleanup-disabled banners only, uses real categories and selects one SKU per family", () => {
  const snapshot = JSON.stringify({ content, products, categories });
  const plan = planHomepageRepair(content, products, categories);
  assert.equal(plan.banners.length, 3);
  assert.equal(plan.featured.length, 10);
  assert.equal(plan.banners[1].data.href, "/category/phu-kien-tu-bep-duoi");
  assert.equal(JSON.stringify({ content, products, categories }), snapshot);
  const drafts = structuredClone(content);
  drafts[0].revision = 4;
  drafts[1].data.image = "/media/uploads/authored.webp";
  assert.equal(planHomepageRepair(drafts, products, categories).banners.length, 1);
  assert.equal(planHomepageRepair(content.map(row => ({ ...row, published: true })), products, categories).banners.length, 0);
  const privateProducts = structuredClone(products); privateProducts[0].published = false;
  assert.throws(() => planHomepageRepair(content, privateProducts, categories), /private/);
  assert.throws(() => planHomepageRepair(content, products, categories.map(row => ({ ...row, data: { ...row.data, visible: false } }))), /unavailable/);
  const variant = structuredClone(products);
  variant[0].data.variantGroupId = "actual-root";
  const root = { ...structuredClone(variant[0]), id: "actual-root", data: { ...variant[0].data, id: "actual-root", code: "root-size" } };
  assert.ok(planHomepageRepair(content, [...variant, root], categories).featured.some(row => row.id === root.id));
});

config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Homepage QA only targets local PostgreSQL.");
test("Repair verifies media/backup, updates only feature flags and three banners, and is idempotent", async () => {
  const schema = `homepage_qa_${randomBytes(6).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "baotin-homepage-"));
  const backupPath = join(directory, "snapshot.json");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const options = { apply: true, backupPath, validateMedia: async () => {} };
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`CREATE TABLE "${schema}".categories (slug text PRIMARY KEY, data jsonb NOT NULL, revision int NOT NULL)`);
    await client.query(`CREATE TABLE "${schema}".products (id text PRIMARY KEY, slug text NOT NULL, data jsonb NOT NULL, published boolean NOT NULL, revision int NOT NULL)`);
    await client.query(`CREATE TABLE "${schema}".content_entries (id text PRIMARY KEY, kind text, data jsonb NOT NULL, published boolean NOT NULL, revision int NOT NULL,"updatedAt" timestamptz DEFAULT now())`);
    await client.query(`CREATE TABLE "${schema}".audit_events ("actorId" text,action text,"resourceId" text,detail jsonb)`);
    for (const row of categories) await client.query(`INSERT INTO "${schema}".categories VALUES ($1,$2,$3)`, [row.slug,row.data,row.revision]);
    for (const row of products) await client.query(`INSERT INTO "${schema}".products VALUES ($1,$2,$3,$4,$5)`, [row.id,row.slug,row.data,row.published,row.revision]);
    for (const row of content) await client.query(`INSERT INTO "${schema}".content_entries (id,kind,data,published,revision) VALUES ($1,$2,$3,$4,$5)`, [row.id,row.kind,row.data,row.published,row.revision]);
    const before = (await client.query(`SELECT * FROM "${schema}".products ORDER BY id`)).rows;
    assert.equal((await repairHomepage(client, schema, { validateMedia: async () => {} })).applied, false);
    await assert.rejects(repairHomepage(client, schema, { ...options, validateMedia: async () => { throw new Error("Invalid image"); } }), /Invalid image/);
    await writeFile(backupPath, "existing backup");
    await assert.rejects(repairHomepage(client, schema, options), /EEXIST/);
    assert.deepEqual((await client.query(`SELECT * FROM "${schema}".products ORDER BY id`)).rows, before);
    await rm(backupPath);
    const result = await repairHomepage(client, schema, options);
    assert.equal(result.applied, true);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(backupPath, "utf8")).products, before);
    const after = (await client.query(`SELECT * FROM "${schema}".products ORDER BY id`)).rows;
    for (let index = 0; index < after.length; index++) assert.deepEqual(after[index], { ...before[index], revision: 4, data: { ...before[index].data, featured: true } });
    assert.equal((await repairHomepage(client, schema, options)).applied, false);
    assert.equal((await client.query(`SELECT COUNT(*) FROM "${schema}".audit_events`)).rows[0].count, "1");
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); await rm(directory, { recursive: true, force: true }); }
});
