import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import ExcelJS from "exceljs";
import EmbeddedPostgres from "embedded-postgres";
import { APPLIANCE_SHEET, APPLIANCE_HEADERS, parseAppliancesWorkbook, applianceProductName, buildApplianceUpdate, commitApplianceUpdate, readApplianceCatalog, applianceChecksum } from "../scripts/update-hafele-appliances.mjs";

const source = { row: 5, code: "536.61.665", model: "HC-IF77D", name: "BẾP TỪ HAFELE HC-IF77D", color: "Màu đen (Black)", size: "770R x 430S x 68C mm", installation: "750R x 365S mm", performance: "• Chức năng gia nhiệt nhanh\n• Child lock", specifications: "• Tổng công suất: 6,7 kW\n• Kích thước sản phẩm: 770R x 430S x 68C mm\n• Kích thước lắp đặt: 750R x 365S mm" };
const product = { id: "hafele-qa", slug: "unchanged-slug", published: true, revision: 4, data: { id: "hafele-qa", slug: "unchanged-slug", code: source.code, name: "OLD PRODUCT", brand: "HAFELE", color: "Trắng", colorGroups: ["white"], size: "old size", specification: "old summary", description: "old description", shortDescription: "old overview", technicalDetails: "old details", price: 270000, listPrice: 360000, b2cDiscount: 25, b2bDiscount: 35, stock: 42, image: "/media/uploads/original.jpg", gallery: ["/media/uploads/original.jpg"], category: "original-category", origin: "Đức", variantGroupId: "existing-group", variantAttributes: [{ name: "Phiên bản", value: "A" }], featured: false, showAuthenticityLabel: true } };
const other = { ...product, id: "fulco-qa", slug: "fulco-qa", data: { ...product.data, id: "fulco-qa", slug: "fulco-qa", brand: "Fulco" } };
const unmatchedHafele = { ...product, id: "other-hafele", slug: "other-hafele", published: false, data: { ...product.data, id: "other-hafele", slug: "other-hafele", code: "111.22.333" } };
const workbook = { hash: "qa-workbook-hash", sheet: APPLIANCE_SHEET, rows: [source, { ...source, row: 6, code: "999.99.999" }] };
const snapshot = { products: [other, product, unmatchedHafele].sort((a,b) => a.id.localeCompare(b.id)), categories: [{ slug: "original-category", data: { name: "Original" }, revision: 7 }] };

test("Parser uses unique-SKU sheet and rejects duplicates, shifted headers and formulas", async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet(APPLIANCE_SHEET);
  sheet.getRow(4).values = APPLIANCE_HEADERS;
  sheet.getRow(5).values = [1, "Bếp", source.code, source.model, source.name, source.color, 62990000, source.size, source.installation, source.performance, source.specifications, 14];
  const catalogue = book.addWorksheet("Catalogue Báo Giá (261 SP)"); catalogue.getRow(5).values = [1, "Repeated combo", source.code];
  const parsed = await parseAppliancesWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  assert.deepEqual(parsed.rows, [source]); assert.ok(!("price" in parsed.rows[0]));
  sheet.getRow(6).values = sheet.getRow(5).values;
  await assert.rejects(parseAppliancesWorkbook(Buffer.from(await book.xlsx.writeBuffer())), /duplicate/);
  sheet.getRow(6).values = [];
  sheet.getCell("J5").value = { formula: '"untrusted"', result: "untrusted" };
  await assert.rejects(parseAppliancesWorkbook(Buffer.from(await book.xlsx.writeBuffer())), /must not be a formula/);
  sheet.getCell("J5").value = source.performance; sheet.getCell("E4").value = "Wrong column";
  await assert.rejects(parseAppliancesWorkbook(Buffer.from(await book.xlsx.writeBuffer())), /Unexpected header/);
});

test("Names use sentence case and preserve each model token", () => {
  assert.equal(applianceProductName(source), "Bếp từ Hafele HC-IF77D");
  assert.equal(applianceProductName({ ...source, name: "CHẬU ĐÁ HÄFELE HS19 - GED2S80 - MÀU ĐEN", model: "HS19 - GED2S80" }), "Chậu đá Hafele HS19 - GED2S80 - màu đen");
  assert.equal(applianceProductName({ ...source, name: "VÒI BẾP HAFELE HT20-GH1P259- MÀU KEM", model: "HT20-GH1P259" }), "Vòi bếp Hafele HT20-GH1P259- màu kem");
  assert.equal(applianceProductName({ ...source, name: "CHẬU ĐÁ BLANCOZIA 8S - MÀU JASMINE", model: "BLANCOZIA 8S" }), "Chậu đá BLANCOZIA 8S - màu jasmine");
  assert.equal(applianceProductName({ ...source, name: "SINK COMBO 1 567.20.537", model: "SINK COMBO 1" }), "Sink combo 1 567.20.537");
});

test("Plan matches HAFELE SKU only and copies complete content without changing prices or variants", () => {
  const original = structuredClone(snapshot), plan = buildApplianceUpdate(workbook, snapshot);
  assert.deepEqual(snapshot, original); assert.equal(plan.changes.length, 1); assert.equal(plan.unmatched.length, 1);
  const patch = plan.changes[0].patch;
  assert.equal(patch.description, source.performance); assert.equal(patch.shortDescription, source.performance);
  assert.equal(patch.size, source.size); assert.deepEqual(patch.colorGroups, ["black"]);
  assert.ok(patch.technicalDetails.includes(`Kích thước cắt đá / lắp đặt: ${source.installation}`));
  assert.ok(patch.technicalDetails.includes("Tổng công suất: 6,7 kW"));
  assert.equal(patch.technicalDetails.split(source.size).length - 1, 1);
  for (const field of ["price", "listPrice", "b2cDiscount", "b2bDiscount", "stock", "image", "gallery", "category", "variantGroupId", "variantAttributes", "slug", "origin"]) assert.ok(!(field in patch));
  const updated = { ...snapshot, products: snapshot.products.map(row => row.id === product.id ? { ...row, data: { ...row.data, ...patch }, revision: row.revision + 1 } : row) };
  assert.equal(buildApplianceUpdate(workbook, updated).changes.length, 0);
  const duplicate = { ...product, id: "duplicate", data: { ...product.data, code: "536-61-665" } };
  assert.throws(() => buildApplianceUpdate(workbook, { ...snapshot, products: [...snapshot.products, duplicate] }), /Ambiguous/);
});

test("Blank optional cells preserve existing fields; oversized text aborts without truncation", () => {
  const empty = { ...source, color: "", size: "", installation: "", performance: "", specifications: "" };
  const plan = buildApplianceUpdate({ ...workbook, rows: [empty] }, snapshot);
  for (const field of ["color", "colorGroups", "size", "description", "shortDescription", "technicalDetails"]) assert.ok(!(field in plan.changes[0].patch));
  assert.throws(() => buildApplianceUpdate({ ...workbook, rows: [{ ...source, performance: "x".repeat(2001) }] }, snapshot), /Nothing truncated/);
});

test("Color remains visible in specifications when optional size/technical cells are blank", () => {
  const colorOnly = { ...source, size: "", installation: "", specifications: "" };
  const current = { ...snapshot, products: snapshot.products.map(row => row.id === product.id ? { ...row, data: { ...row.data, technicalDetails: "" } } : row) };
  const plan = buildApplianceUpdate({ ...workbook, rows: [colorOnly] }, current);
  assert.equal(plan.changes[0].patch.technicalDetails, "Màu sắc / Hoàn thiện: Màu đen (Black)");
  const updated = { ...current, products: current.products.map(row => row.id === product.id ? { ...row, data: { ...row.data, ...plan.changes[0].patch }, revision: row.revision + 1 } : row) };
  assert.equal(buildApplianceUpdate({ ...workbook, rows: [colorOnly] }, updated).changes.length, 0);
});

test("PostgreSQL update backs up first, rejects stale/out-of-scope plans, rolls back failures and is idempotent", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-appliances-qa-"));
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password: "Appliances-QA-password", port, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let client;
  try {
    await database.initialise(); await database.start(); client = database.getPgClient("postgres", "127.0.0.1"); await client.connect();
    const schema = "appliances_qa";
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.products (id text PRIMARY KEY,slug text UNIQUE,data jsonb,published boolean,revision integer NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.categories (slug text PRIMARY KEY,data jsonb,revision integer)`);
    await client.query(`CREATE TABLE ${schema}.audit_events ("actorId" text,action text,"resourceId" text,detail jsonb)`);
    await client.query(`INSERT INTO ${schema}.products SELECT id,slug,data,published,revision FROM jsonb_to_recordset($1::jsonb) AS p(id text,slug text,data jsonb,published boolean,revision integer)`, [JSON.stringify(snapshot.products)]);
    await client.query(`INSERT INTO ${schema}.categories SELECT slug,data,revision FROM jsonb_to_recordset($1::jsonb) AS c(slug text,data jsonb,revision integer)`, [JSON.stringify(snapshot.categories)]);
    const before = await readApplianceCatalog(client, schema), plan = buildApplianceUpdate(workbook, before), backup = join(directory, "before.json");
    await assert.rejects(commitApplianceUpdate(client, schema, { ...plan, checksum: "stale" }, backup), /changed after preview/);
    const forbidden = structuredClone(plan); forbidden.changes[0].patch.price = 1;
    await assert.rejects(commitApplianceUpdate(client, schema, forbidden, backup), /reviewed HAFELE content scope/);
    assert.equal(applianceChecksum(await readApplianceCatalog(client, schema)), applianceChecksum(before));
    // Force the audit insert to fail after UPDATE; the product transaction must roll back.
    await client.query(`ALTER TABLE ${schema}.audit_events ADD CONSTRAINT reject_qa CHECK (action <> 'hafele-appliances-content-update')`);
    await assert.rejects(commitApplianceUpdate(client, schema, plan, join(directory, "rolled-back.json")), /reject_qa/);
    assert.deepEqual(await readApplianceCatalog(client, schema), before);
    await client.query(`ALTER TABLE ${schema}.audit_events DROP CONSTRAINT reject_qa`);
    const result = await commitApplianceUpdate(client, schema, plan, backup);
    assert.equal(result.applied, true); assert.equal(result.updated, 1); assert.equal((await stat(backup)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(backup, "utf8")); assert.deepEqual(saved.products, before.products); assert.deepEqual(saved.categories, before.categories);
    const after = await readApplianceCatalog(client, schema);
    assert.deepEqual(after.products.find(row => row.id === other.id), before.products.find(row => row.id === other.id));
    assert.deepEqual(after.products.find(row => row.id === unmatchedHafele.id), before.products.find(row => row.id === unmatchedHafele.id));
    assert.deepEqual(after.categories, before.categories);
    const nextPlan = buildApplianceUpdate(workbook, after); assert.equal(nextPlan.changes.length, 0);
    assert.equal((await commitApplianceUpdate(client, schema, nextPlan, join(directory, "not-needed.json"))).applied, false);
    assert.equal((await client.query(`SELECT count(*) FROM ${schema}.audit_events`)).rows[0].count, "1");
  } finally { if (client) await client.end(); await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
