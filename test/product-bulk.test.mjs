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

test("bulk product API partially publishes valid SKU and enforces permissions, revisions and atomic discounts", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-bulk-qa-"));
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
    const draft = { name: "QA imported product", code: "BULK-1", alternateCode: "NEW-BULK-1", slug: "bulk-1", category: "phu-kien-bep", subcategory: "", brand: "Fulco", unit: "Bộ", listPrice: 100000, b2cDiscount: 60, b2bDiscount: 65, specification: "Inox 304", material: "", color: "", size: "", origin: "", description: "", gallery: ["/media/uploads/qa.webp"], featured: false, published: false };
    const first = await call("/admin/products", draft, cookies.admin); assert.equal(first.status, 201, JSON.stringify(first.data));
    const second = await call("/admin/products", { ...draft, code: "BULK-2", alternateCode: "NEW-BULK-2", slug: "bulk-2", gallery: [] }, cookies.admin); assert.equal(second.status, 201);
    const choose = result => ({ id: result.data.id, revision: result.data.product.revision });
    const selection = [choose(first), choose(second)];
    const payload = { action: "discounts", products: selection, b2cDiscount: 20 };
    assert.equal((await call("/admin/products/bulk", payload)).status, 401);
    for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await call("/admin/products/bulk", payload, cookies[role])).status, 403);
    for (const value of [100, -1, 12.345, null, "20"]) assert.equal((await call("/admin/products/bulk", { ...payload, b2cDiscount: value }, cookies.admin)).status, 400);
    assert.equal((await call("/admin/products/bulk", { ...payload, products: [] }, cookies.admin)).status, 400);
    assert.equal((await call("/admin/products/bulk", { ...payload, products: [selection[0], selection[0]] }, cookies.admin)).status, 400);
    assert.equal((await call("/admin/products/bulk", { action: "discounts", products: selection }, cookies.admin)).status, 400);
    const invalidPublish = await call("/admin/products/bulk", { action: "publish", products: [selection[1]] }, cookies.admin);
    assert.equal(invalidPublish.status, 201);
    assert.equal(invalidPublish.data.updated, 0);
    assert.deepEqual(invalidPublish.data.products, []);
    assert.equal(invalidPublish.data.skipped[0].code, "BULK-2");
    assert.ok(invalidPublish.data.skipped[0].reason.includes("ít nhất một ảnh"));
    const stored = async id => (await sql.query('SELECT * FROM bulk_qa.products WHERE id=$1', [id])).rows[0];
    assert.equal((await stored(first.data.id)).published, false);
    assert.equal((await stored(second.data.id)).revision, selection[1].revision);
    const update = await call("/admin/products/bulk", payload, cookies.sales); assert.equal(update.status, 201, JSON.stringify(update.data));
    assert.equal(update.data.updated, 2);
    const changed = await stored(first.data.id); assert.equal(changed.data.price, 80000); assert.equal(changed.data.b2bDiscount, 65); assert.equal(changed.revision, selection[0].revision + 1);
    assert.equal((await call("/admin/products/bulk", payload, cookies.admin)).status, 409);
    const missing = await call("/admin/products/bulk", { ...payload, products: [...update.data.products.map(({ id, revision }) => ({ id, revision })), { id: "missing", revision: 1 }] }, cookies.admin); assert.equal(missing.status, 404);
    const currentSelection = update.data.products.map(({ id, revision }) => ({ id, revision }));
    const stalePublish = await call("/admin/products/bulk", { action: "publish", products: currentSelection.map(item => item.id === second.data.id ? { ...item, revision: item.revision - 1 } : item) }, cookies.admin);
    assert.equal(stalePublish.status, 409);
    assert.equal((await stored(first.data.id)).published, false);
    const secondBefore = await stored(second.data.id);
    const unselected = await call("/admin/products", { ...draft, code: "UNSELECTED", slug: "unselected", alternateCode: "" }, cookies.admin); assert.equal(unselected.status, 201);
    const published = await call("/admin/products/bulk", { action: "publish", products: currentSelection }, cookies.admin); assert.equal(published.status, 201, JSON.stringify(published.data));
    assert.equal(published.data.updated, 1);
    assert.equal(published.data.products.length, 1);
    assert.equal(published.data.products[0].id, first.data.id);
    assert.deepEqual(published.data.skipped.map(product => product.code), ["BULK-2"]);
    assert.equal((await stored(changed.id)).published, true);
    assert.deepEqual(await stored(second.data.id), secondBefore);
    assert.equal((await stored(unselected.data.id)).published, false);
    const audit = (await sql.query("SELECT detail FROM bulk_qa.audit_events WHERE action='products-bulk-publish' ORDER BY at DESC LIMIT 1")).rows[0].detail;
    assert.deepEqual(audit.skipped, published.data.skipped);
    assert.equal(audit.products.length, 1);
    const aliasSearch = await fetch(`${base}/catalog/search?q=NEW-BULK-1&pageSize=10`).then(response => response.json());
    assert.ok(aliasSearch.products.some(product => product.id === changed.id));
    const aliasExact = await fetch(`${base}/catalog/selection?code=NEW-BULK-1`).then(response => response.json());
    assert.ok(aliasExact.products.some(product => product.id === changed.id));
    const adminAlias = await fetch(`${base}/admin/browse?resource=products&branch=${encodeURIComponent("Quy Nhơn")}&q=NEW-BULK-1&pageSize=10`, { headers: { Cookie: cookies.admin } }).then(response => response.json());
    assert.equal(adminAlias.products.length, 1);
    assert.equal(adminAlias.products[0].id, changed.id);
    const selectionURL = `${base}/admin/products/selection?branch=${encodeURIComponent("Quy Nhơn")}&q=NEW-BULK-1&status=published`;
    const compact = await fetch(selectionURL, { headers: { Cookie: cookies.admin } }).then(response => response.json());
    assert.equal(compact.count, 1);
    assert.deepEqual(Object.keys(compact.products[0]).sort(), ["code", "id", "revision"]);
    assert.equal(compact.products[0].id, changed.id);
    for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await fetch(selectionURL, { headers: { Cookie: cookies[role] } })).status, 403);
    assert.equal((await fetch(selectionURL)).status, 401);
    const hidden = await call("/admin/products/bulk", { action: "private", products: published.data.products.map(({ id, revision }) => ({ id, revision })) }, cookies.admin); assert.equal(hidden.status, 201);
    assert.equal((await stored(changed.id)).published, false);
    const legacy = await call("/admin/products", { ...draft, code: "LEGACY", slug: "legacy", listPrice: undefined, b2cDiscount: undefined, b2bDiscount: undefined, price: 100000 }, cookies.admin); assert.equal(legacy.status, 201);
    const legacyBulk = await call("/admin/products/bulk", { action: "discounts", products: [choose(legacy)], b2bDiscount: 50 }, cookies.admin); assert.equal(legacyBulk.status, 400);
    const beforeDiscount = await stored(changed.id);
    const mixedDiscount = await call("/admin/products/bulk", { action: "discounts", products: [{ id: beforeDiscount.id, revision: beforeDiscount.revision }, choose(legacy)], b2cDiscount: 10 }, cookies.admin);
    assert.equal(mixedDiscount.status, 400);
    assert.deepEqual(await stored(changed.id), beforeDiscount);
    const missingImage = await call("/admin/products", { ...draft, code: "MISSING-IMAGE", slug: "missing-image", alternateCode: "" }, cookies.admin); assert.equal(missingImage.status, 201);
    await sql.query("UPDATE bulk_qa.products SET data=jsonb_set(data,'{gallery}','[\"/media/uploads/missing.webp\"]') WHERE id=$1", [missingImage.data.id]);
    const badCategory = await call("/admin/products", { ...draft, code: "BAD-CATEGORY", slug: "bad-category", alternateCode: "" }, cookies.admin); assert.equal(badCategory.status, 201);
    await sql.query("UPDATE bulk_qa.products SET data=jsonb_set(data,'{category}','\"qa-deleted-category\"') WHERE id=$1", [badCategory.data.id]);
    const currentGood = await stored(changed.id);
    const otherIssues = await call("/admin/products/bulk", { action: "publish", products: [{ id: currentGood.id, revision: currentGood.revision }, choose(missingImage), choose(badCategory)] }, cookies.admin);
    assert.equal(otherIssues.status, 201);
    assert.equal(otherIssues.data.updated, 1);
    assert.equal(otherIssues.data.skipped.length, 2);
    assert.ok(otherIssues.data.skipped.find(product => product.code === "MISSING-IMAGE").reason.includes("không tồn tại"));
    assert.ok(otherIssues.data.skipped.find(product => product.code === "BAD-CATEGORY").reason.includes("Danh mục"));
    assert.equal((await stored(missingImage.data.id)).published, false);
    assert.equal((await stored(badCategory.data.id)).published, false);
    assert.ok((await sql.query("SELECT action FROM bulk_qa.audit_events WHERE action LIKE 'products-bulk-%'")).rowCount >= 3);
    await sql.query("INSERT INTO bulk_qa.products (id,slug,data,published,revision) SELECT 'LIMIT-'||i,'limit-'||i,jsonb_build_object('id','LIMIT-'||i,'code','LIMIT-'||i,'name','Limit test'),false,1 FROM generate_series(1,501) i");
    assert.equal((await fetch(`${base}/admin/products/selection?branch=${encodeURIComponent("Quy Nhơn")}&q=LIMIT-`, { headers: { Cookie: cookies.admin } })).status, 400);
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    if (sql) await sql.end();
    await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
