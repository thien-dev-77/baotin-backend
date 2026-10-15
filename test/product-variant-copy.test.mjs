import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import EmbeddedPostgres from "embedded-postgres";
import sharp from "sharp";

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test("variant content copy is selective, atomic, revision guarded and restricted to the same group", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-variant-copy-qa-"));
  const dbPort = await freePort(), apiPort = await freePort();
  const password = `QA-${randomBytes(12).toString("hex")}`;
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password, port: dbPort, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let child, sql;
  let logs = "";
  try {
    await database.initialise(); await database.start();
    sql = database.getPgClient("postgres", "127.0.0.1"); await sql.connect();
    const media = join(directory, "media"); await mkdir(join(media, "uploads"), { recursive: true });
    await writeFile(join(media, "uploads/qa.webp"), await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } }).webp().toBuffer());
    child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`, DB_SCHEMA: "bulk_qa", DB_SSL: "false", DB_SYNCHRONIZE: "true", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"), NODE_ENV: "development", COOKIE_SECURE: "false", PORT: String(apiPort), HOST: "127.0.0.1", MEDIA_DIR: media, FRONTEND_ORIGINS: "http://localhost:3010", SMTP_URL: "", KIOTVIET_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
    const base = `http://127.0.0.1:${apiPort}/api`;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`QA API failed: ${logs}`);
      if (await fetch(`${base}/health`).then(response => response.ok).catch(() => false)) break;
      if (attempt === 149) throw new Error(`QA API startup timed out: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const call = async (path, body, cookie = "") => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost:3010", "X-BaoTin-Client": "web", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
    };
    const cookies = {};
    for (const role of ["admin", "sales", "warehouse", "accountant", "kh001"]) {
      const result = await call("/auth/login", { identity: `${role}@baotin.local`, password }); assert.equal(result.status, 201); cookies[role] = result.cookie;
    }
    const draft = { name: "Giá bát nâng hạ điện", code: "NSP-00179", slug: "copy-700", category: "phu-kien-bep", subcategory: "", brand: "Fulco", unit: "Bộ", listPrice: 21630000, b2cDiscount: 45, b2bDiscount: 60, specification: "Model: NSP-00179", material: "Inox 304", color: "Xám", size: "700mm", origin: "Malaysia", description: "<p>Mô tả đã sửa</p>", shortDescription: "<p>Nội dung ngắn</p>", technicalDetails: "<p>Model: NSP-00179<br>Kích thước: 700mm</p>", usageGuide: "<p>Hướng dẫn chung</p>", warranty: "5 năm", gallery: ["/media/uploads/qa.webp"], featured: false, published: false, variantGroupId: "self", variantAttributes: [{ name: "Kích thước", value: "700mm" }] };
    const create = async changes => {
      const result = await call("/admin/products", { ...draft, ...changes }, cookies.admin);
      assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.product;
    };
    const source = await create({});
    const second = await create({ name: "Giá bát 800 cũ", code: "NSP-00180", slug: "copy-800", variantGroupId: source.id, variantAttributes: [{ name: "Kích thước", value: "800mm" }], description: "Mô tả riêng", technicalDetails: "Model: NSP-00180", listPrice: 23210000, warranty: "2 năm", gallery: [] });
    const third = await create({ name: "Giá bát 900 cũ", code: "NSP-00181", slug: "copy-900", variantGroupId: source.id, variantAttributes: [{ name: "Kích thước", value: "900mm" }], description: "Nội dung riêng khác", technicalDetails: "Model: NSP-00181", listPrice: 24990000 });
    const outsider = await create({ code: "OTHER", slug: "copy-other", variantGroupId: undefined, variantAttributes: undefined });
    const stored = async id => (await sql.query('SELECT * FROM bulk_qa.products WHERE id=$1', [id])).rows[0];
    const choose = product => ({ id: product.id, revision: product.revision });
    const endpoint = `/admin/products/${source.id}/copy-to-variants`;
    const payload = { revision: source.revision, fields: ["name", "description"], products: [choose(second), choose(third)] };
    assert.equal((await call(endpoint, payload)).status, 401);
    for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await call(endpoint, payload, cookies[role])).status, 403);
    for (const field of ["code", "price", "stock", "size", "color", "slug", "variantAttributes", "variantGroupId", "published"]) {
      assert.equal((await call(endpoint, { ...payload, fields: [field] }, cookies.admin)).status, 400, field);
    }
    for (const changes of [{ fields: [] }, { fields: ["name", "name"] }, { products: [] }, { products: [choose(second), choose(second)] }, { revision: null }, { products: [{ id: second.id }] }, { fields: null }]) {
      assert.equal((await call(endpoint, { ...payload, ...changes }, cookies.admin)).status, 400);
    }
    assert.equal((await call(endpoint, { ...payload, products: [choose(source)] }, cookies.admin)).status, 400);
    assert.equal((await call(endpoint, { ...payload, products: [choose(outsider)] }, cookies.admin)).status, 400);
    assert.equal((await call(endpoint, { ...payload, products: [{ id: "missing", revision: 1 }] }, cookies.admin)).status, 404);
    assert.equal((await call(`/admin/products/${outsider.id}/copy-to-variants`, { ...payload, revision: outsider.revision }, cookies.admin)).status, 400);
    assert.equal((await call(endpoint, { ...payload, revision: source.revision + 1 }, cookies.admin)).status, 409);
    assert.equal((await call(endpoint, { ...payload, products: [choose(second), { ...choose(third), revision: third.revision + 1 }] }, cookies.admin)).status, 409);
    await sql.query("UPDATE bulk_qa.products SET data=jsonb_set(data,'{stock}','100') WHERE id=$1", [second.id]);
    const beforeSecond = await stored(second.id), beforeThird = await stored(third.id), beforeSource = await stored(source.id);
    const result = await call(endpoint, payload, cookies.sales);
    assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.updated, 2);
    for (const before of [beforeSecond, beforeThird]) {
      const after = await stored(before.id);
      assert.deepEqual(after.data, { ...before.data, name: source.name, description: source.description });
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.published, before.published); assert.equal(after.slug, before.slug);
    }
    assert.deepEqual(await stored(source.id), beforeSource);
    assert.equal((await call(endpoint, payload, cookies.admin)).status, 409);
    const updatedSecond = await stored(second.id);
    const copyTechnical = await call(endpoint, { revision: source.revision, fields: ["technicalDetails", "gallery", "warranty"], products: [{ id: second.id, revision: updatedSecond.revision }] }, cookies.admin);
    assert.equal(copyTechnical.status, 201, JSON.stringify(copyTechnical.data));
    const technical = await stored(second.id);
    assert.deepEqual(technical.data, { ...updatedSecond.data, technicalDetails: source.technicalDetails, specification: source.specification, warranty: source.warranty, gallery: source.gallery, image: source.gallery[0] });
    assert.equal((await stored(third.id)).revision, beforeThird.revision + 1);
    // Any SKU can be the source, including a child rather than the group anchor.
    const childCopy = await call(`/admin/products/${third.id}/copy-to-variants`, { revision: beforeThird.revision + 1, fields: ["origin"], products: [{ id: source.id, revision: source.revision }] }, cookies.admin);
    assert.equal(childCopy.status, 201, JSON.stringify(childCopy.data));
    await sql.query("UPDATE bulk_qa.products SET data=jsonb_set(jsonb_set(data,'{gallery}','[]'),'{specification}','\"\"'),revision=revision+1 WHERE id=$1", [source.id]);
    await sql.query("UPDATE bulk_qa.products SET published=true WHERE id=$1", [third.id]);
    const invalidSource = await stored(source.id), beforeRollbackSecond = await stored(second.id), beforeRollbackThird = await stored(third.id);
    const invalidCopy = await call(endpoint, { revision: invalidSource.revision, fields: ["technicalDetails", "gallery"], products: [{ id: second.id, revision: beforeRollbackSecond.revision }, { id: third.id, revision: beforeRollbackThird.revision }] }, cookies.admin);
    assert.equal(invalidCopy.status, 400, JSON.stringify(invalidCopy.data));
    assert.deepEqual(await stored(second.id), beforeRollbackSecond); assert.deepEqual(await stored(third.id), beforeRollbackThird);
    const audit = (await sql.query("SELECT detail FROM bulk_qa.audit_events WHERE action='product-variant-content-copy' AND \"resourceId\"=$1 ORDER BY at DESC LIMIT 1", [source.id])).rows[0]?.detail;
    assert.deepEqual(audit.fields, ["technicalDetails", "gallery", "warranty"]);
    assert.deepEqual(audit.products.map(product => product.id), [second.id]);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    if (sql) await sql.end();
    await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
