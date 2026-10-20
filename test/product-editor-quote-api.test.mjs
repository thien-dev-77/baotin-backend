import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import EmbeddedPostgres from "embedded-postgres";
import sharp from "sharp";
import { DataSource } from "typeorm";
import { entities, UserEntity } from "../dist/database/entities.js";
import { DatabaseService } from "../dist/database/database.service.js";
import { LedgerService } from "../dist/ledger/ledger.service.js";
import { PricePolicyService } from "../dist/catalog/price-policy.service.js";
import { OrdersService } from "../dist/orders/orders.service.js";
import { NotificationsService } from "../dist/notifications/notifications.service.js";

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test("Editor reads only its group; checkout quotes only selected SKUs; proxy throttling isolates accounts", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-product-optimization-qa-"));
  const dbPort = await freePort(), apiPort = await freePort();
  const password = `QA-${randomBytes(12).toString("hex")}`, proxySecret = randomBytes(32).toString("hex");
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password, port: dbPort, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog: () => {}, onError: () => {} });
  let child, sql, source, logs = "";
  try {
    await database.initialise(); await database.start();
    sql = database.getPgClient("postgres", "127.0.0.1"); await sql.connect();
    const media = join(directory, "media"); await mkdir(join(media, "uploads"), { recursive: true });
    await writeFile(join(media, "uploads/qa.webp"), await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } }).webp().toBuffer());
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`;
    child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, DATABASE_URL: databaseUrl, DB_SCHEMA: "optimization_qa", DB_SSL: "false", DB_SYNCHRONIZE: "true", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, JWT_SECRET: randomBytes(32).toString("hex"), PROXY_CLIENT_IP_SECRET: proxySecret, NODE_ENV: "development", COOKIE_SECURE: "false", PORT: String(apiPort), HOST: "127.0.0.1", MEDIA_DIR: media, FRONTEND_ORIGINS: "http://localhost:3010", SMTP_URL: "", KIOTVIET_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
    const base = `http://127.0.0.1:${apiPort}/api`;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`QA API failed: ${logs}`);
      if (await fetch(`${base}/health`).then(response => response.ok).catch(() => false)) break;
      if (attempt === 149) throw new Error(`QA API startup timed out: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const call = async (path, method = "GET", body, cookie = "", headers = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: "http://localhost:3010", "X-BaoTin-Client": "web", "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
    };
    const cookies = {};
    for (const role of ["admin", "boss", "sales", "warehouse", "accountant", "kh001"]) {
      const result = await call("/auth/login", "POST", { identity: `${role}@baotin.local`, password });
      assert.equal(result.status, 201, JSON.stringify(result.data)); cookies[role] = result.cookie;
    }
    const draft = { name: "Giá bát riêng", category: "phu-kien-bep", subcategory: "", brand: "Fulco", unit: "Bộ", listPrice: 100000, b2cDiscount: 20, b2bDiscount: 30, specification: "Inox 304", material: "Inox 304", color: "Bạc", size: "600mm", origin: "China", description: "Nội dung cần giữ nguyên", technicalDetails: "Model: Riêng", gallery: ["/media/uploads/qa.webp"], featured: false, published: true };
    let serial = 0;
    const create = async changes => {
      const code = `OPT-${++serial}`;
      const result = await call("/admin/products", "POST", { ...draft, code, slug: code.toLowerCase(), ...changes }, cookies.admin);
      assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.product;
    };
    const root = await create({ variantGroupId: "self", variantAttributes: [{ name: "Kích thước", value: "600mm" }] });
    const sibling = await create({ variantGroupId: root.id, variantAttributes: [{ name: "Kích thước", value: "700mm" }], published: false });
    const unrelated = await create({ description: "X".repeat(9000) });
    await sql.query('INSERT INTO optimization_qa.inventory_balances (id,branch,"productId","onHand") VALUES ($1,$2,$3,17),($4,$5,$3,29)', [`Quy Nhơn:${root.id}`, "Quy Nhơn", root.id, `Tuy Hòa:${root.id}`, "Tuy Hòa"]);
    const path = `/admin/products/${sibling.id}/editor?${new URLSearchParams({ branch: "Quy Nhơn" })}`;
    assert.equal((await call(path)).status, 401);
    for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await call(path, "GET", undefined, cookies[role])).status, 403);
    assert.equal((await call(path.replace("Quy+Nh%C6%A1n", "Tuy+H%C3%B2a"), "GET", undefined, cookies.sales)).status, 403);
    assert.equal((await call(`/admin/products/${root.id}/editor?branch=invalid`, "GET", undefined, cookies.admin)).status, 400);
    assert.equal((await call(`/admin/products/${root.id}/editor`, "GET", undefined, cookies.admin)).status, 400);
    assert.equal((await call(`/admin/products/missing/editor?${new URLSearchParams({ branch: "Quy Nhơn" })}`, "GET", undefined, cookies.admin)).status, 404);
    for (const role of ["admin", "boss", "sales"]) {
      const result = await call(path, "GET", undefined, cookies[role]);
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.products.length, 2);
      assert.ok(result.data.products.some(product => product.id === sibling.id && !product.published));
      assert.ok(result.data.products.every(product => product.revision > 0 && product.id !== unrelated.id));
      assert.equal(result.data.products.find(product => product.id === root.id).stock, 17);
    }
    const otherBranch = await call(`/admin/products/${root.id}/editor?${new URLSearchParams({ branch: "Tuy Hòa" })}`, "GET", undefined, cookies.admin);
    assert.equal(otherBranch.data.products.find(product => product.id === root.id).stock, 29);
    const standalone = await call(`/admin/products/${unrelated.id}/editor?${new URLSearchParams({ branch: "Quy Nhơn" })}`, "GET", undefined, cookies.admin);
    assert.equal(standalone.data.products.length, 1); assert.equal(standalone.data.products[0].description.length, 9000);

    const queries = [];
    const logger = { logQuery: (query, parameters) => queries.push({ query, parameters }), logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} };
    source = new DataSource({ type: "postgres", url: databaseUrl, schema: "optimization_qa", entities, synchronize: false, logging: ["query"], logger }); await source.initialize();
    const db = new DatabaseService(); db.source = source;
    const ledger = new LedgerService(db), pricing = new PricePolicyService(db);
    const orders = new OrdersService(db, pricing, ledger, new NotificationsService(db));
    const observed = [], stock = ledger.stock.bind(ledger);
    ledger.stock = async (products, ...args) => { observed.push(products.map(product => product.id)); return stock(products, ...args); };
    const quoteInput = { items: [{ productId: root.id, quantity: 2 }], delivery: "Nhận tại cửa hàng", coupon: "" };
    queries.length = 0;
    assert.equal((await orders.quote(quoteInput)).total, 160000);
    assert.deepEqual(observed.pop(), [root.id]);
    const productReads = queries.filter(({ query }) => /FROM .*"products"/.test(query));
    assert.equal(productReads.length, 1); assert.match(productReads[0].query, /"id" IN/); assert.ok(productReads[0].parameters.includes(root.id));
    const buyer = await source.getRepository(UserEntity).findOneByOrFail({ email: "kh001@baotin.local" });
    const selection = await call(`/catalog/selection?ids=${root.id}`, "GET", undefined, cookies.kh001);
    const b2b = await orders.quote(quoteInput, buyer);
    assert.equal(b2b.items[0].unitPrice, selection.data.products[0].customerPrice);
    assert.deepEqual(observed.pop(), [root.id]);
    for (const items of [[{ productId: sibling.id, quantity: 1 }], [{ productId: "missing", quantity: 1 }], [{ productId: root.id, quantity: 18 }]]) await assert.rejects(orders.quote({ ...quoteInput, items }), /không còn bán|tồn kho không đủ/);
    await assert.rejects(orders.quote({ ...quoteInput, items: [...quoteInput.items, ...quoteInput.items] }), /Mỗi SKU/);
    const first = await call("/orders", "POST", { ...quoteInput, customer: { name: "QA Customer", phone: "0901234567", email: "", address: "", city: "", district: "", ward: "" }, payment: "Thanh toán khi nhận hàng (COD)", note: "QA", expectedTotal: 1 }, "", { "Idempotency-Key": randomUUID() });
    assert.equal(first.status, 409, `checkout still rejects a changed total: ${JSON.stringify(first.data)}`);

    for (let index = 0; index < 12; index++) assert.equal((await call("/auth/login", "POST", { identity: `proxy-user-${index}@example.test`, password: "not-correct" })).status, 401, "different accounts behind the same proxy do not share eight attempts");
    for (let index = 0; index < 8; index++) assert.equal((await call("/auth/login", "POST", { identity: "blocked@example.test", password: "not-correct" }, "", { "x-forwarded-for": `192.0.2.${index + 1}` })).status, 401);
    assert.equal((await call("/auth/login", "POST", { identity: " BLOCKED@EXAMPLE.TEST ", password: "not-correct" })).status, 429, "rotating forwarding headers cannot bypass per-account protection");
    assert.equal((await call("/auth/login", "POST", { identity: "boss@baotin.local", password })).status, 201, "another real account can still log in");
    const timestamp = String(Math.floor(Date.now() / 1000)), clientIp = "192.0.2.99";
    const signature = createHmac("sha256", proxySecret).update(["v1", timestamp, "POST", "/api/auth/login", clientIp].join("\n")).digest("hex");
    const signed = { "x-baotin-client-ip": clientIp, "x-baotin-proxy-timestamp": timestamp, "x-baotin-proxy-signature": signature };
    for (let index = 0; index < 8; index++) assert.equal((await call("/auth/login", "POST", { identity: `signed-user-${index}@example.test`, password: "not-correct" }, "", signed)).status, 401);
    assert.equal((await call("/auth/login", "POST", { identity: "signed-user-last@example.test", password: "not-correct" }, "", signed)).status, 429, "verified client IP retains its strict source limit");
    const unsigned = { ...signed, "x-baotin-proxy-signature": "0".repeat(64) };
    assert.equal((await call("/auth/login", "POST", { identity: "unsigned-user@example.test", password: "not-correct" }, "", unsigned)).status, 401, "an invalid signature cannot select another IP's bucket");
  } finally {
    if (source?.isInitialized) await source.destroy();
    if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    if (sql) await sql.end(); await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
