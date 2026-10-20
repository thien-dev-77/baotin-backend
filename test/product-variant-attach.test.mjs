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

test("attach existing SKUs preserves product data, guards membership and revisions, and rolls back atomically", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-variant-attach-qa-"));
  const dbPort = await freePort(), apiPort = await freePort();
  const password = `QA-${randomBytes(12).toString("hex")}`;
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password, port: dbPort, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let child, sql, logs = "";
  try {
    await database.initialise(); await database.start();
    sql = database.getPgClient("postgres", "127.0.0.1"); await sql.connect();
    const media = join(directory, "media"); await mkdir(join(media, "uploads"), { recursive: true });
    await writeFile(join(media, "uploads/qa.webp"), await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } }).webp().toBuffer());
    child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`, DB_SCHEMA: "attach_qa", DB_SSL: "false", DB_SYNCHRONIZE: "true", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"), NODE_ENV: "development", COOKIE_SECURE: "false", PORT: String(apiPort), HOST: "127.0.0.1", MEDIA_DIR: media, FRONTEND_ORIGINS: "http://localhost:3010", SMTP_URL: "", KIOTVIET_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
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
      const login = await call("/auth/login", "POST", { identity: `${role}@baotin.local`, password });
      assert.equal(login.status, 201); cookies[role] = login.cookie;
    }
    const draft = { name: "Giá bát Fulco", category: "phu-kien-bep", subcategory: "", brand: "Fulco", unit: "Bộ", listPrice: 1000000, b2cDiscount: 10, b2bDiscount: 20, specification: "Inox 304", material: "Inox 304", materialGroups: ["inox-304"], color: "Bạc", colorGroups: null, size: "600mm", origin: "China", originGroups: ["china"], description: "<p>Nội dung riêng</p>", technicalDetails: "Model: Riêng", gallery: ["/media/uploads/qa.webp"], featured: false, published: true };
    let serial = 0;
    const create = async (changes = {}) => {
      const code = `ATTACH-${++serial}`;
      const result = await call("/admin/products", "POST", { ...draft, code, slug: code.toLowerCase(), ...changes }, cookies.admin);
      assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.product;
    };
    const attributes = size => [{ name: "Kích thước", value: `${size}mm` }, { name: "Màu sắc", value: "Bạc" }];
    const root = await create({ variantGroupId: "self", variantAttributes: attributes(600) });
    const sibling = await create({ variantGroupId: root.id, variantAttributes: attributes(700) });
    const target = await create({ published: false, name: "SKU riêng tư", listPrice: 2345000, size: "Cũ", color: "Đen" });
    const read = async id => {
      const result = await call(`/admin/products/${id}/variants`, "GET", undefined, cookies.admin);
      assert.equal(result.status, 200); return result.data.products;
    };
    const choose = ({ id, revision }) => ({ id, revision });
    const payload = { groupId: root.id, products: (await read(root.id)).map(choose), targetId: target.id, targetRevision: target.revision, attributes: attributes(800) };
    const endpoint = `/admin/products/${sibling.id}/attach-variant`;
    const attach = (body = payload, role = "admin", path = endpoint) => call(path, "POST", body, cookies[role] || "");
    const stored = async id => (await sql.query("SELECT * FROM attach_qa.products WHERE id=$1", [id])).rows[0];
    const snapshot = async () => (await sql.query("SELECT id, data, revision, published FROM attach_qa.products ORDER BY id")).rows;
    const unchanged = await snapshot();
    assert.equal((await attach(payload, "guest")).status, 401);
    for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await attach(payload, role)).status, 403);
    for (const changes of [{ products: [] }, { products: [payload.products[0], payload.products[0]] }, { targetRevision: 0 }, { attributes: null }, { attributes: [{ name: "Kích thước", value: "" }] }]) assert.equal((await attach({ ...payload, ...changes })).status, 400);
    assert.equal((await attach({ ...payload, targetId: "missing" })).status, 404);
    assert.equal((await attach({ ...payload, groupId: "missing" })).status, 404);
    assert.equal((await attach(payload, "admin", "/admin/products/missing/attach-variant")).status, 404);
    assert.equal((await attach({ ...payload, products: payload.products.slice(1) })).status, 409);
    assert.equal((await attach({ ...payload, products: payload.products.map(item => ({ ...item, revision: item.revision + 1 })) })).status, 409);
    assert.equal((await attach({ ...payload, targetRevision: target.revision + 1 })).status, 409);
    assert.equal((await attach({ ...payload, targetId: sibling.id })).status, 400);
    assert.equal((await attach({ ...payload, attributes: [{ name: "Chiều rộng", value: "800mm" }] })).status, 400);
    const conflict = await attach({ ...payload, attributes: attributes(600) });
    assert.equal(conflict.status, 409); assert.ok(conflict.data.message.includes(root.code)); assert.ok(conflict.data.message.includes(target.code));
    assert.deepEqual(await snapshot(), unchanged, "invalid requests cannot mutate any product");
    for (const [key, value] of [["brand", "HAFELE"], ["category", "chau-voi"], ["unit", "cái"]]) {
      // Deliberately inject a different category too; attach must reject it without relying on the editor.
      await sql.query("UPDATE attach_qa.products SET data=jsonb_set(data,ARRAY[$2],$3::jsonb) WHERE id=$1", [target.id, key, JSON.stringify(value)]);
      const mismatch = await attach(); assert.equal(mismatch.status, 400); assert.ok(mismatch.data.message.includes(target.code));
      await sql.query("UPDATE attach_qa.products SET data=$2::jsonb WHERE id=$1", [target.id, JSON.stringify(unchanged.find(row => row.id === target.id).data)]);
    }
    assert.equal((await attach({ ...payload, targetId: sibling.id, targetRevision: sibling.revision }, "admin", `/admin/products/${target.id}/attach-variant`)).status, 409);
    const other = await create({ variantGroupId: "self", variantAttributes: attributes(900) });
    const otherChild = await create({ variantGroupId: other.id, variantAttributes: attributes(1000) });
    for (const product of [other, otherChild]) assert.equal((await attach({ ...payload, targetId: product.id, targetRevision: product.revision })).status, 400);
    await sql.query('INSERT INTO attach_qa.inventory_balances (id,branch,"productId","onHand") VALUES ($1,$2,$3,17)', [`Quy Nhơn:${target.id}`, "Quy Nhơn", target.id]);
    const beforeRoot = await stored(root.id), beforeSibling = await stored(sibling.id), beforeTarget = await stored(target.id);
    const success = await attach(payload, "sales");
    assert.equal(success.status, 201, JSON.stringify(success.data)); assert.equal(success.data.products.length, 3);
    const after = await stored(target.id);
    assert.deepEqual(after.data, { ...beforeTarget.data, variantGroupId: root.id, variantAttributes: attributes(800), size: "800mm", color: "Bạc" });
    assert.equal(after.revision, beforeTarget.revision + 1); assert.equal(after.published, false); assert.equal(after.slug, beforeTarget.slug);
    assert.deepEqual(await stored(root.id), beforeRoot); assert.deepEqual(await stored(sibling.id), beforeSibling);
    assert.equal((await sql.query('SELECT "onHand" FROM attach_qa.inventory_balances WHERE "productId"=$1', [target.id])).rows[0].onHand, 17);
    const publicGroup = await call(`/catalog/product/${root.slug}`);
    assert.equal(publicGroup.status, 200); assert.ok(publicGroup.data.variants.every(product => product.id !== target.id), "linking does not publish a private SKU");
    assert.equal((await attach()).status, 409, "a replay cannot reuse the old membership snapshot");
    const single = await create(), isolated = await create({ variantGroupId: "self", variantAttributes: attributes(450) });
    const beforeSingle = await stored(single.id), beforeIsolated = await stored(isolated.id);
    const emptyPayload = { groupId: single.id, products: [choose(single)], targetId: isolated.id, targetRevision: isolated.revision, attributes: [] };
    const emptyResult = await attach(emptyPayload, "boss", `/admin/products/${single.id}/attach-variant`);
    assert.equal(emptyResult.status, 201, JSON.stringify(emptyResult.data));
    assert.deepEqual((await stored(single.id)).data, { ...beforeSingle.data, variantGroupId: single.id, variantAttributes: [] });
    assert.deepEqual((await stored(isolated.id)).data, { ...beforeIsolated.data, variantGroupId: single.id, variantAttributes: [] });
    const detail = await call(`/catalog/product/${single.slug}`);
    assert.equal(detail.data.variants.length, 2, "a standalone product can become a group selected by SKU");
    const audits = (await sql.query("SELECT * FROM attach_qa.audit_events WHERE action='product-variant-attach' ORDER BY at")).rows;
    assert.equal(audits.length, 2); assert.equal(audits[0].resourceId, target.id); assert.equal(audits[0].detail.groupId, root.id);
    const rollbackRoot = await create(), rollbackTarget = await create();
    const beforeRollback = await snapshot();
    await sql.query("CREATE FUNCTION attach_qa.reject_attach_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='product-variant-attach' THEN RAISE EXCEPTION 'QA rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_attach_audit BEFORE INSERT ON attach_qa.audit_events FOR EACH ROW EXECUTE FUNCTION attach_qa.reject_attach_audit()");
    const failed = await attach({ groupId: rollbackRoot.id, products: [choose(rollbackRoot)], targetId: rollbackTarget.id, targetRevision: rollbackTarget.revision, attributes: [] }, "admin", `/admin/products/${rollbackRoot.id}/attach-variant`);
    assert.equal(failed.status, 500); assert.deepEqual(await snapshot(), beforeRollback, "audit failure rolls back both anchor initialization and target attachment");
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    if (sql) await sql.end();
    await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
