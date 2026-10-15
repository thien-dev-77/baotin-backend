import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import EmbeddedPostgres from "embedded-postgres";

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("variant groups expose fresh revisions and allow removing a dimension without changing SKU data", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-variant-groups-qa-"));
  const dbPort = await freePort(), apiPort = await freePort();
  const password = `QA-${randomBytes(12).toString("hex")}`;
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password, port: dbPort, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let child, sql, logs = "";
  try {
    await database.initialise(); await database.start();
    sql = database.getPgClient("postgres", "127.0.0.1"); await sql.connect();
    child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`, DB_SCHEMA: "variants_qa", DB_SSL: "false", DB_SYNCHRONIZE: "true", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"), NODE_ENV: "development", COOKIE_SECURE: "false", PORT: String(apiPort), HOST: "127.0.0.1", MEDIA_DIR: join(directory, "media"), FRONTEND_ORIGINS: "http://localhost:3010", SMTP_URL: "", KIOTVIET_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
    const base = `http://127.0.0.1:${apiPort}/api`;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`QA API failed: ${logs}`);
      if (await fetch(`${base}/health`).then(response => response.ok).catch(() => false)) break;
      if (attempt === 149) throw new Error(`QA API startup timed out: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const call = async (path, method = "GET", body, cookie = "") => {
      const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: "http://localhost:3010", "X-BaoTin-Client": "web", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
    };
    const cookies = {};
    for (const role of ["admin", "boss", "sales", "warehouse", "accountant", "kh001"]) {
      const result = await call("/auth/login", "POST", { identity: `${role}@baotin.local`, password });
      assert.equal(result.status, 201); cookies[role] = result.cookie;
    }
    const draft = { name: "Giá đựng bát Fulco chữ V", code: "QA-600", slug: "qa-600", category: "phu-kien-bep", subcategory: "", brand: "Fulco", unit: "Bộ", listPrice: 1000000, b2cDiscount: 10, b2bDiscount: 20, specification: "Inox 304", material: "Inox 304", color: "Bạc", size: "600mm", origin: "", description: "Mô tả riêng", gallery: [], featured: false, published: false };
    const attributes = size => [{ name: "Phiên bản", value: `QA-${size}` }, { name: "Kích thước", value: `${size}mm` }];
    const create = async changes => {
      const result = await call("/admin/products", "POST", { ...draft, ...changes }, cookies.admin);
      assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.product;
    };
    const root = await create({ variantGroupId: "self", variantAttributes: attributes(600) });
    const sibling = await create({ code: "QA-700", slug: "qa-700", variantGroupId: root.id, variantAttributes: attributes(700) });
    await create({ code: "QA-800", slug: "qa-800", variantGroupId: root.id, variantAttributes: attributes(800) });
    const standalone = await create({ code: "QA-SINGLE", slug: "qa-single" });
    const path = `/admin/products/${root.id}/variants`;
    const read = async (id = root.id, role = "admin") => {
      const result = await call(`/admin/products/${id}/variants`, "GET", undefined, cookies[role]);
      assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.products;
    };
    const savedRows = async () => (await sql.query("SELECT id, revision, data, published FROM variants_qa.products WHERE id=$1 OR data->>'variantGroupId'=$1 ORDER BY id", [root.id])).rows;
    const configure = (rows, transform) => call(path, "PATCH", { products: rows.map(product => ({ id: product.id, revision: product.revision, attributes: transform(product.variantAttributes) })) }, cookies.admin);
    assert.equal((await call(path)).status, 401);
    for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await call(path, "GET", undefined, cookies[role])).status, 403);
    assert.equal((await call("/admin/products/missing/variants", "GET", undefined, cookies.admin)).status, 404);
    const initial = await read();
    assert.equal(initial.length, 3);
    assert.ok(initial.every(product => product.published === false && product.revision === 1));
    assert.deepEqual(await read(sibling.id, "sales"), initial);
    assert.deepEqual(await read(root.id, "boss"), initial);
    const single = await read(standalone.id);
    assert.equal(single.length, 1); assert.equal(single[0].variantGroupId, undefined);
    const beforeReads = await savedRows();
    await read(); assert.deepEqual(await savedRows(), beforeReads, "reads never increment revisions");
    const changed = await call(`/admin/products/${sibling.id}`, "PATCH", { ...draft, code: sibling.code, slug: sibling.slug, variantGroupId: root.id, variantAttributes: sibling.variantAttributes, revision: sibling.revision, name: "Tên mới đã sửa", listPrice: 2000000 }, cookies.admin);
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const stale = await configure(initial, values => values.slice(1));
    assert.equal(stale.status, 409, "stale revisions still cannot overwrite a concurrent edit");
    const fresh = await read();
    assert.equal(fresh.find(product => product.id === sibling.id).revision, 2);
    const beforeRemoval = await savedRows();
    const removed = await configure(fresh, values => values.slice(1));
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    for (const after of await savedRows()) {
      const before = beforeRemoval.find(product => product.id === after.id);
      assert.equal(after.revision, before.revision + 1);
      assert.deepEqual(after.data, { ...before.data, variantAttributes: before.data.variantAttributes.slice(1) });
      assert.equal(after.published, before.published);
    }
    const reloaded = await read(sibling.id);
    assert.deepEqual(reloaded.map(product => product.id), fresh.map(product => product.id));
    assert.equal(reloaded.find(product => product.id === sibling.id).name, "Tên mới đã sửa");
    assert.equal(reloaded.find(product => product.id === sibling.id).listPrice, 2000000);
    const renamed = await configure(reloaded, values => values.map(value => ({ ...value, name: "Chiều rộng" })));
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    const beforeDuplicate = await savedRows();
    const duplicate = await configure(await read(), () => [{ name: "Kích thước", value: "600mm" }]);
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.data.message, /Tổ hợp thuộc tính/);
    assert.deepEqual(await savedRows(), beforeDuplicate, "invalid combinations roll back the entire group");
    const audit = await sql.query("SELECT detail FROM variants_qa.audit_events WHERE action='product-variant-group-update' AND \"resourceId\"=$1 ORDER BY at", [root.id]);
    assert.equal(audit.rows.length, 2);
    assert.deepEqual(audit.rows[0].detail.attributes, ["Kích thước"]);
  } finally {
    if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    if (sql) await sql.end();
    await database.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
