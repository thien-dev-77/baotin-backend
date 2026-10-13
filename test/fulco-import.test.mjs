import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import sharp from "sharp";
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { parseFulcoWorkbook } from "../dist/catalog/fulco-import.js";
import { buildFulcoImport } from "../dist/catalog/fulco-import-plan.js";
import { downloadFulcoImage } from "../scripts/fulco-media.mjs";
import { commitFulcoImport, importKey } from "../scripts/import-fulco.mjs";

const HEADERS = ["STT", "Nhóm sản phẩm", "Mã sản phẩm", "Mã SP mới", "Tên sản phẩm (Web mẫu)", "Link sản phẩm mẫu", "Gallery (Link ảnh)", "Nội dung ngắn (Web)", "Thông tin sản phẩm (Web)", "Thông số (Web)", "Hướng dẫn sử dụng (Web)", "Mô tả Sản phẩm & Quy cách", "ĐVT", "Khoang tủ", "Giá niêm yết (VNĐ)", "Chiết khấu", "Giá sau CK (VNĐ)", "Trang catalog"];
const options = { discountTarget: "both", b2cDiscount: 0, publish: false };
async function workbookFixture(edit) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Bảng Báo Giá Chi Tiết");
  sheet.getRow(4).values = HEADERS;
  const images = Array.from({ length: 12 }, (_, index) => `https://fulco.vn/static/media/image ${index}.jpg`).join("\n");
  for (const [index, size] of [600, 700].entries()) sheet.getRow(index + 5).values = [index + 1, "GIÁ BÁT ĐĨA", `FC36-${size}`, `NEW-${size}`, "Giá bát inox", { text: "Source", hyperlink: "https://fulco.vn/gia-bat" }, images, "Chất liệu: Inox 304\nBảo hành: 24 tháng", "Detailed information", "Chất liệu: Inox 304\n" + "Thông số dài\n".repeat(70), "Hướng dẫn\nLắp đặt theo kích thước.", "Quy cách\nMô tả sản phẩm", "Bộ", String(size), 3560000, 0.6, { formula: "ROUND(O5*(1-P5),0)", result: 9999999 }, "Trang 1"];
  sheet.getRow(7).values = [3, "THÙNG GẠO", "FCP303-Đ", "", "-", "Không có link", "", "", "", "", "", "Thùng gạo màu đen", "Bộ", "300", 1000000, 0.65, { formula: "ROUND(O7*(1-P7),0)" }, "Trang 2"];
  sheet.getRow(8).values = [null, "TỔNG CỘNG", null];
  const ignored = book.addWorksheet("Do not import"); ignored.addRow(["FAKE-SKU"]);
  if (edit) edit(sheet);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("Fulco first-sheet parsing retains content and interprets Excel percentage fractions", async () => {
  const parsed = await parseFulcoWorkbook(await workbookFixture());
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].discount, 60);
  assert.equal(parsed.rows[2].discount, 65);
  assert.equal(parsed.rows[0].alternateCode, "NEW-600");
  assert.equal(parsed.rows[0].sourceUrl, "https://fulco.vn/gia-bat");
  assert.equal(parsed.rows[0].sourceImages.length, 12);
  assert.ok(parsed.rows[0].sourceImages[0].includes("%20"));
  assert.ok(parsed.rows[0].technicalDetails.length > 500);
  assert.ok(parsed.rows[0].usageGuide.includes("Lắp đặt"));
  const imageURLs = new Map(parsed.rows.flatMap(row => row.sourceImages).map((url, index) => [url, `/media/uploads/test-${index}.webp`]));
  const plan = buildFulcoImport(parsed, imageURLs, options);
  assert.equal(plan.products.length, 3);
  assert.equal(plan.categories.length, 2);
  assert.equal(plan.variantGroups, 1);
  assert.ok(plan.products.every(item => !item.published && item.data.stock === 0));
  assert.ok(plan.categories.every(item => item.visible === false));
  const first = plan.products[0].data;
  assert.equal(first.price, 1424000);
  assert.equal(first.b2cDiscount, 60);
  assert.equal(first.b2bDiscount, 60);
  assert.equal(first.gallery.length, 12);
  assert.equal(first.technicalDetails, parsed.rows[0].technicalDetails);
  assert.equal(first.variantAttributes[0].value, "600mm");
  assert.equal(first.variantGroupId, first.id);
  assert.equal(plan.products[1].data.variantGroupId, first.id);
  assert.equal(plan.products[2].data.gallery.length, 0);
  const retail = buildFulcoImport(parsed, imageURLs, { ...options, discountTarget: "b2b", b2cDiscount: 20, publish: true });
  assert.equal(retail.products[0].data.price, 2848000);
  assert.equal(retail.products[2].published, false);
  assert.equal(retail.products[0].published, true);
  await assert.rejects(parseFulcoWorkbook(await workbookFixture(sheet => { sheet.getRow(6).getCell(3).value = "fc36-600"; })), /Duplicate SKU/);
  await assert.rejects(parseFulcoWorkbook(await workbookFixture(sheet => { sheet.getRow(5).getCell(15).value = { formula: "1+1", result: 2 }; })), /Invalid list price/);
  await assert.rejects(parseFulcoWorkbook(await workbookFixture(sheet => { sheet.getRow(5).getCell(7).value = "http://127.0.0.1/image.jpg"; })), /HTTPS/);
});

test("Image download validates origin, content type, byte size and image bytes", async () => {
  let called = false;
  await assert.rejects(downloadFulcoImage("https://localhost/private", async () => { called = true; }), /not allowed/);
  assert.equal(called, false);
  const url = "https://fulco.vn/static/media/test.png";
  await assert.rejects(downloadFulcoImage(url, async () => new Response("error", { status: 503 })), /503/);
  await assert.rejects(downloadFulcoImage(url, async () => new Response("html", { headers: { "content-type": "text/html" } })), /not an image/);
  await assert.rejects(downloadFulcoImage(url, async () => new Response("fake", { headers: { "content-type": "image/png" } })), /Input buffer/);
  await assert.rejects(downloadFulcoImage(url, async () => new Response("large", { headers: { "content-type": "image/png", "content-length": String(51 * 1024 * 1024) } })), /too large/);
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const result = await downloadFulcoImage(url, async () => new Response(image, { headers: { "content-type": "image/png" } }));
  assert.equal((await sharp(result.bytes).metadata()).format, "webp");
  assert.match(result.hash, /^[a-f0-9]{64}$/);
});

test("Catalog import is transactional, private, idempotent and does not overwrite existing SKUs", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-fulco-qa-"));
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password: "FulcoImport-QA-password", port, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let client;
  try {
    await database.initialise(); await database.start();
    client = database.getPgClient("postgres", "127.0.0.1"); await client.connect();
    const schema = "fulco_qa";
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.products (id text PRIMARY KEY, slug text UNIQUE, data jsonb, published boolean, revision integer NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.categories (slug text PRIMARY KEY, data jsonb, revision integer NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.audit_events (id uuid DEFAULT gen_random_uuid(), "actorId" text, action text, "resourceId" text, detail jsonb, at timestamptz DEFAULT now())`);
    const parsed = await parseFulcoWorkbook(await workbookFixture());
    const images = new Map(parsed.rows.flatMap(row => row.sourceImages).map((url, index) => [url, `/media/uploads/test-${index}.webp`]));
    const plan = buildFulcoImport(parsed, images, options);
    const key = importKey(parsed.hash, options);
    const details = { actorId: "OPERATOR", workbookHash: parsed.hash, options, reportPath: "private-report.json" };
    await client.query(`INSERT INTO ${schema}.products VALUES ('OTHER','other',$1,true,1)`, [JSON.stringify({ code: "FC36-600" })]);
    await assert.rejects(commitFulcoImport(client, schema, key, plan, details), /conflicts/);
    assert.equal(Number((await client.query(`SELECT count(*) FROM ${schema}.categories`)).rows[0].count), 0);
    await client.query(`DELETE FROM ${schema}.products WHERE id='OTHER'`);
    const result = await commitFulcoImport(client, schema, key, plan, details);
    assert.equal(result.products, 3); assert.equal(result.private, 3); assert.equal(result.published, 0);
    const stored = (await client.query(`SELECT * FROM ${schema}.products`)).rows;
    assert.ok(stored.every(row => !row.published));
    assert.equal(stored.find(row => row.data.code === "FC36-600").data.technicalDetails, parsed.rows[0].technicalDetails);
    const repeat = await commitFulcoImport(client, schema, key, buildFulcoImport(parsed, images, options), details);
    assert.equal(repeat.alreadyImported, true);
    assert.equal(Number((await client.query(`SELECT count(*) FROM ${schema}.products`)).rows[0].count), 3);
  } finally {
    if (client) await client.end();
    await database.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
