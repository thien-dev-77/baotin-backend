import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseHafeleWorkbook, buildHafeleImport, HAFELE_HEADERS } from "../dist/catalog/hafele-import.js";
import { categoryIdentityConflict, sentenceCaseCategoryName } from "../dist/catalog/category.rules.js";
import { normalizeHafeleCategories } from "../scripts/normalize-hafele-categories.mjs";
import { MAX_PRODUCT_GALLERY } from "../dist/catalog/product.constants.js";
import { commitHafeleImport, readHafeleCatalog, hafeleCatalogChecksum, verifyHafeleMedia } from "../scripts/import-hafele.mjs";

const category = (slug, name, parentSlug = "") => ({ slug, data: { slug, name, parentSlug, image: "", description: "", subcategories: [], visible: true, sortOrder: 10 }, revision: 7 });
const existing = [category("thiet-bi-bep-gia-dung", "Thiết bị bếp & Đồ gia dụng"), category("bep-tu", "Bếp từ", "thiet-bi-bep-gia-dung"), category("phu-kien-tu-quan-ao", "Phụ kiện tủ quần áo")];

async function fixture(edit) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Bảng Báo Giá Chi Tiết");
  sheet.getRow(4).values = HAFELE_HEADERS;
  const paths = Array.from({ length: 27 }, (_, index) => `/media/uploads/001-00-001_${index + 1}.jpg`).join("\n");
  const row = (stt, path, code, name, gallery, cabinet, packaging, price = 1_000_000) => [stt, path, code, "P-12345678", name,
    "https://www.hafele.com.vn/vi/product/test/", gallery, "Nội dung ngắn", "Thông tin đầy đủ", "Công suất: 2400 W\nĐiện áp: 220 V", "Hướng dẫn", packaging,
    "Bộ", cabinet, "R500 x S400 x C100mm", price, 0.25, { formula: "INVALID()", result: 1 }, 0.35, { formula: "INVALID()", result: 2 }];
  sheet.getRow(5).values = row(1, "KOSMO-C | Tủ dưới | Rổ", "001.00.001", "Rổ bếp", paths, "600", "Chất liệu: Inox 304");
  sheet.getRow(6).values = row(1, "KOSMO-C | Tủ dưới | Rổ", "001.00.002", "Rổ bếp", "/media/uploads/001-00-002_1.jpg", "700", "Chất liệu: Inox 304");
  sheet.getRow(7).values = row(2, "THIẾT BỊ BẾP | BẾP TỪ", "002.00.001", "Bếp QA", "/media/uploads/002-00-001_1.jpg", "500", "Màu trắng mờ (Lựa chọn 1)", 1_414_999.8);
  sheet.getRow(8).values = row(2, "THIẾT BỊ BẾP | BẾP TỪ", "002.00.002", "Bếp QA", "/media/uploads/002-00-002_1.jpg", "500", "Màu xám đậm (Lựa chọn 1)");
  sheet.getRow(9).values = row(3, "PHỤ KIỆN TỦ QUẦN ÁO", "003.00.001", "Thiếu giá/ảnh", "", "", "", null);
  sheet.getRow(10).values = row(4, "PHỤ KIỆN CỬA | Ray cửa | Cửa thẳng", "004.00.001", "Ray dùng chung", "/media/uploads/004-00-001_1.jpg", "", "Dùng chung cho cả hai loại cửa");
  sheet.getRow(11).values = row(5, "PHỤ KIỆN CỬA | Ray cửa | Cửa xếp", "004.00.001", "Ray dùng chung", "/media/uploads/004-00-001_1.jpg", "", "Ray trượt trên");
  for (const column of ["A", "B", "E", "I", "J", "K", "M"]) sheet.mergeCells(`${column}5:${column}6`);
  for (const column of ["A", "B", "E", "M"]) sheet.mergeCells(`${column}7:${column}8`);
  sheet.getRow(12).values = [null, "TỔNG CỘNG", null];
  if (edit) edit(sheet);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("HAFELE parser preserves merged families, exact paths, 27-image gallery and source pricing", async () => {
  const parsed = await parseHafeleWorkbook(await fixture());
  assert.equal(parsed.rows.length, 7);
  assert.equal(parsed.rows[1].family, "A5");
  assert.equal(parsed.rows[1].name, "Rổ bếp");
  assert.equal(parsed.rows[0].code, "001.00.001");
  assert.equal(parsed.rows[0].gallery.length, 27);
  assert.equal(parsed.rows[0].gallery[0], "/media/uploads/001-00-001_1.jpg");
  assert.equal(parsed.rows[0].b2cDiscount, 25);
  assert.equal(parsed.rows[0].b2bDiscount, 35);
  assert.equal(parsed.rows[2].listPrice, 1_415_000);
  assert.equal(parsed.rows[4].missingPrice, true);
  assert.ok(parsed.warnings.some(row => row.code === "003.00.001" && row.messages.some(message => message.includes("Thiếu giá"))));
  await assert.rejects(parseHafeleWorkbook(await fixture(sheet => { sheet.getCell("P5").value = { formula: "1+1", result: 2 }; })), /dữ liệu gốc/);
  await assert.rejects(parseHafeleWorkbook(await fixture(sheet => { sheet.getCell("N5").value = "Âm tủ"; })), /Khoang tủ/);
  await assert.rejects(parseHafeleWorkbook(await fixture(sheet => { sheet.getCell("G5").value = "/media/uploads/001.00.001_1.jpg"; })), /Gallery/);
  await assert.rejects(parseHafeleWorkbook(await fixture(sheet => { sheet.getCell("G5").value = Array.from({ length: MAX_PRODUCT_GALLERY + 1 }, (_, i) => `/media/uploads/test-${i}.jpg`).join("\n"); })), /Gallery/);
});

test("Plan reuses categories, deduplicates shared rail SKUs and creates meaningful unique variants", async () => {
  const parsed = await parseHafeleWorkbook(await fixture()), original = structuredClone(existing);
  const plan = buildHafeleImport(parsed, existing);
  assert.deepEqual(existing, original);
  assert.equal(plan.products.length, 6);
  assert.equal(plan.variantGroups, 2);
  assert.deepEqual(new Set(plan.reusedCategorySlugs), new Set(existing.map(item => item.slug)));
  assert.ok(plan.products.every(item => item.data.brand === "HAFELE" && !item.published && item.data.stock === 0));
  const byCode = new Map(plan.products.map(item => [item.data.code, item]));
  assert.equal(byCode.get("001.00.001").data.price, 750_000);
  assert.equal(byCode.get("001.00.001").data.gallery.length, 27);
  assert.deepEqual(byCode.get("001.00.002").data.variantAttributes, [{ name: "Kích thước", value: "700mm" }]);
  assert.equal(byCode.get("002.00.001").data.category, "bep-tu");
  assert.deepEqual(byCode.get("002.00.001").data.variantAttributes, [{ name: "Màu sắc", value: "trắng mờ" }]);
  assert.deepEqual(byCode.get("004.00.001").sourceRows, [10, 11]);
  const sharedCategory = plan.categories.find(item => item.slug === byCode.get("004.00.001").data.category);
  assert.equal(sharedCategory.name, "Ray cửa");
  assert.ok(byCode.get("004.00.001").data.description.includes("Ray trượt trên"));
  assert.ok(plan.categories.every(item => item.slug.length <= 80 && item.visible === false));
  const conflicting = structuredClone(parsed); conflicting.rows.at(-1).unit = "Thanh";
  assert.throws(() => buildHafeleImport(conflicting, existing), /không thống nhất/);
  const ambiguous = structuredClone(parsed); ambiguous.rows[1].cabinet = ambiguous.rows[0].cabinet;
  assert.throws(() => buildHafeleImport(ambiguous, existing), /Chưa đủ thuộc tính/);
});

test("Variants use explicit capacity and direction instead of a duplicate size or SKU fallback", async () => {
  const parsed = await parseHafeleWorkbook(await fixture());
  const [first, second] = parsed.rows;
  first.cabinet = second.cabinet = "400";
  first.packaging = "Dung tích 8 Lít"; second.packaging = "Dung tích 14 Lít";
  let products = buildHafeleImport(parsed, existing).products;
  assert.deepEqual(products[0].data.variantAttributes, [{ name: "Dung tích", value: "8 L" }]);
  first.packaging = "Mở cánh bên phải"; second.packaging = "Mở cánh bên trái";
  products = buildHafeleImport(parsed, existing).products;
  assert.deepEqual(products[0].data.variantAttributes, [{ name: "Hướng", value: "Phải" }]);
});

test("Duplicate category names are scoped to their parent while slugs remain globally unique", () => {
  const categories = [category("old", "Giá bát", "kosmo-c").data];
  assert.equal(categoryIdentityConflict(categories, { slug: "new", name: " GIÁ BÁT ", parentSlug: "kosmo-c" }), true);
  assert.equal(categoryIdentityConflict(categories, { slug: "new", name: "Giá bát", parentSlug: "kosmo-p" }), false);
  assert.equal(categoryIdentityConflict(categories, { slug: "old", name: "Other", parentSlug: "kosmo-p" }), true);
  assert.equal(categoryIdentityConflict(categories, categories[0], "old"), false);
});

test("HAFELE category labels use Vietnamese sentence case without changing source paths or existing labels", async () => {
  assert.equal(sentenceCaseCategoryName("  PHỤ KIỆN  TỦ BẾP DÒNG OVAN  "), "Phụ kiện tủ bếp dòng ovan");
  assert.equal(sentenceCaseCategoryName("ĐỒ GIA DỤNG".normalize("NFD")), "Đồ gia dụng");
  const parsed = await parseHafeleWorkbook(await fixture());
  const plan = buildHafeleImport(parsed, existing);
  assert.equal(plan.categories[0].name, "Kosmo-c");
  assert.equal(plan.categoryMappings[0].path[0], "KOSMO-C");
  assert.equal(existing[0].data.name, "Thiết bị bếp & Đồ gia dụng");
});

test("Media preflight uses HEAD and rejects missing images, stale caches and wrong origins", async () => {
  const path = "/media/uploads/001-00-001_1.jpg";
  let calls = 0;
  const verified = await verifyHafeleMedia([path, path], "https://api.example.test", undefined, async (url, options) => { calls++; assert.equal(options.method, "HEAD"); return new Response(null, { headers: { "content-type": "image/jpeg" } }); });
  assert.equal(calls, 1);
  assert.equal(verified.results.length, 1);
  await assert.rejects(verifyHafeleMedia([path], "https://api.example.test", { ...verified, at: "2000-01-01" }), /stale/);
  await assert.rejects(verifyHafeleMedia([path], "https://other.example.test", verified), /origin/);
  await assert.rejects(verifyHafeleMedia([path], "https://api.example.test", undefined, async () => new Response(null, { status: 404 })), /Missing/);
});

test("Import atomically inserts HAFELE only, preserves Fulco/categories and is idempotent", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-hafele-qa-"));
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password: "Hafele-QA-password", port, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let client;
  try {
    await database.initialise(); await database.start(); client = database.getPgClient("postgres", "127.0.0.1"); await client.connect();
    const schema = "hafele_qa";
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.products (id text PRIMARY KEY,slug text UNIQUE,data jsonb,published boolean,revision integer NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.categories (slug text PRIMARY KEY,data jsonb,revision integer NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.audit_events (id uuid DEFAULT gen_random_uuid(),"actorId" text,action text,"resourceId" text,detail jsonb,at timestamptz DEFAULT now())`);
    for (const item of existing) await client.query(`INSERT INTO ${schema}.categories VALUES ($1,$2,$3)`, [item.slug, item.data, item.revision]);
    const fulco = { id: "FULCO", code: "FC-KEEP", brand: "Fulco", stock: 100, price: 900000, variantGroupId: "FULCO", gallery: ["/media/uploads/fulco.webp"] };
    await client.query(`INSERT INTO ${schema}.products VALUES ('FULCO','fulco-keep',$1,true,17)`, [fulco]);
    const before = await readHafeleCatalog(client, schema), checksum = hafeleCatalogChecksum(before);
    const workbook = await parseHafeleWorkbook(await fixture()), plan = buildHafeleImport(workbook, existing);
    const media = { base: "https://api.example.test", at: new Date().toISOString(), results: [...new Set(plan.products.flatMap(item => item.data.gallery))].map(path => ({ path, ok: true, status: 200, type: "image/jpeg" })) };
    const options = { expectedChecksum: checksum, backupPath: join(directory, "before.json"), media, reportPath: "report.json" };
    await assert.rejects(commitHafeleImport(client, schema, plan, { ...options, expectedChecksum: "stale" }), /changed after preview/);
    await assert.rejects(commitHafeleImport(client, schema, plan, { ...options, media: { ...media, results: [] } }), /not been verified/);
    await client.query(`ALTER TABLE ${schema}.products ADD CONSTRAINT fail_second CHECK (data->>'code' <> '002.00.002')`);
    await assert.rejects(commitHafeleImport(client, schema, plan, options), /fail_second/);
    assert.equal(hafeleCatalogChecksum(await readHafeleCatalog(client, schema)), checksum);
    await client.query(`ALTER TABLE ${schema}.products DROP CONSTRAINT fail_second`);
    const result = await commitHafeleImport(client, schema, plan, { ...options, backupPath: join(directory, "success-before.json") });
    assert.equal(result.products, 6); assert.equal(result.private, 6); assert.equal(result.fulcoProductsUnchanged, 1);
    const after = await readHafeleCatalog(client, schema);
    assert.deepEqual(after.products.find(item => item.id === "FULCO"), before.products[0]);
    for (const item of before.categories) assert.deepEqual(after.categories.find(row => row.slug === item.slug), item);
    const repeat = await commitHafeleImport(client, schema, plan, options);
    assert.equal(repeat.alreadyImported, true);
    assert.equal((await readHafeleCatalog(client, schema)).products.length, 7);
    const modified = buildHafeleImport({ ...workbook, hash: "different-source" }, after.categories);
    await assert.rejects(commitHafeleImport(client, schema, modified, { ...options, expectedChecksum: hafeleCatalogChecksum(after) }), /Existing SKU/);
    assert.deepEqual(await readHafeleCatalog(client, schema), after);
    const selectedCategory = plan.categories[0];
    await client.query(`UPDATE ${schema}.categories SET data=jsonb_set(data,'{name}',to_jsonb($1::text)) WHERE slug=$2`, [selectedCategory.name.toLocaleUpperCase("vi"), selectedCategory.slug]);
    const beforeCase = await readHafeleCatalog(client, schema);
    const preview = await normalizeHafeleCategories(client, schema);
    assert.equal(preview.applied, false); assert.equal(preview.categories.length, 1);
    assert.deepEqual(await readHafeleCatalog(client, schema), beforeCase);
    const normalized = await normalizeHafeleCategories(client, schema, { apply: true, backupPath: join(directory, "case-before.json") });
    assert.equal(normalized.applied, true); assert.equal(normalized.categories.length, 1);
    const afterCase = await readHafeleCatalog(client, schema);
    assert.deepEqual(afterCase.products, beforeCase.products);
    for (const item of existing) assert.deepEqual(afterCase.categories.find(row => row.slug === item.slug), beforeCase.categories.find(row => row.slug === item.slug));
    assert.equal(afterCase.categories.find(row => row.slug === selectedCategory.slug).data.name, selectedCategory.name);
    assert.equal((await normalizeHafeleCategories(client, schema, { apply: true })).categories.length, 0);
  } finally {
    if (client) await client.end(); await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
