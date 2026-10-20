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
import { DataSource } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { entities, CategoryEntity, CustomerEntity, OrderEntity, ProductEntity, ReceiptEntity, SessionEntity, UserEntity } from "../dist/database/entities.js";
import { CreditEntity, InventoryEntity, LedgerEntity } from "../dist/database/operations.entities.js";
import { DatabaseService } from "../dist/database/database.service.js";
import { LedgerService } from "../dist/ledger/ledger.service.js";
import { AuthService } from "../dist/auth/auth.service.js";
import { AdminBrowseService } from "../dist/admin/admin-browse.service.js";
import { ReportsController } from "../dist/reports/reports.controller.js";
import { businessDate } from "../dist/orders/orders.service.js";
import { agingBucket } from "../dist/reports/report.rules.js";

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test("Admin reads stay bounded, authorized and financially equivalent", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "baotin-admin-performance-"));
  const dbPort = await freePort(), apiPort = await freePort();
  const password = randomBytes(20).toString("hex"), secret = randomBytes(32).toString("hex");
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "pg"), user: "postgres", password, port: dbPort, persistent: false, authMethod: "scram-sha-256", initdbFlags: ["--locale=C", "--encoding=UTF8"], postgresFlags: ["-h", "127.0.0.1"], onLog() {}, onError() {} });
  let child, source, logs = "";
  try {
    await database.initialise(); await database.start();
    await mkdir(join(directory, "media")); await writeFile(join(directory, "empty.env"), "");
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${dbPort}/postgres`;
    child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, ENV_FILE: join(directory, "empty.env"), DATABASE_URL: databaseUrl, DB_SCHEMA: "performance_qa", DB_SSL: "false", DB_SYNCHRONIZE: "true", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, JWT_SECRET: secret, NODE_ENV: "development", COOKIE_SECURE: "false", PORT: String(apiPort), HOST: "127.0.0.1", MEDIA_DIR: join(directory, "media"), FRONTEND_ORIGINS: "http://localhost:3010", SMTP_URL: "", KIOTVIET_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
    const base = `http://127.0.0.1:${apiPort}/api`;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      if (await fetch(`${base}/health`).then(response => response.ok).catch(() => false)) break;
      if (i === 199) throw new Error(`API startup failed: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const call = async (path, cookie = "", method = "GET", body) => {
      const response = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: "http://localhost:3010", "X-BaoTin-Client": "web", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
    };
    const cookies = {};
    for (const role of ["admin", "sales", "warehouse", "accountant", "kh001"]) {
      const result = await call("/auth/login", "", "POST", { identity: `${role}@baotin.local`, password });
      assert.equal(result.status, 201, JSON.stringify(result.data)); cookies[role] = result.cookie;
    }
    const queries = [];
    const logger = { logQuery: query => queries.push(query), logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} };
    source = new DataSource({ type: "postgres", url: databaseUrl, schema: "performance_qa", entities, synchronize: false, logging: ["query"], logger }); await source.initialize();
    const db = new DatabaseService(); db.source = source;
    const ledger = new LedgerService(db), browse = new AdminBrowseService(db, ledger);
    const jwt = new JwtService({ secret });
    const auth = new AuthService(db, jwt, ledger, {});
    const request = cookie => ({ cookies: { baotin_session: decodeURIComponent(cookie.split("=").slice(1).join("=")) } });
    let admin;
    await t.test("One live auth lookup preserves revocation, expiry, current permissions and concurrent logins", async () => {
      queries.length = 0;
      admin = await auth.authenticate(request(cookies.admin));
      assert.equal(queries.length, 1); assert.match(queries[0], /INNER JOIN .*sessions/);
      assert.equal(admin.passwordHash, undefined);
      const second = await call("/auth/login", "", "POST", { identity: "admin@baotin.local", password });
      assert.equal(second.status, 201);
      await auth.authenticate(request(cookies.admin)); await auth.authenticate(request(second.cookie));
      const users = source.getRepository(UserEntity);
      await users.update(admin.id, { role: "sales", branches: ["Tuy Hòa"] });
      const changed = await auth.authenticate(request(cookies.admin));
      assert.equal(changed.role, "sales"); assert.deepEqual(changed.branches, ["Tuy Hòa"]);
      await users.update(admin.id, { role: "admin", branches: admin.branches, disabled: true });
      await assert.rejects(auth.authenticate(request(cookies.admin)), /Phiên đăng nhập/);
      await users.update(admin.id, { disabled: false });
      const claims = jwt.decode(request(second.cookie).cookies.baotin_session);
      await source.getRepository(SessionEntity).update(claims.sid, { expiresAt: new Date(0) });
      await assert.rejects(auth.authenticate(request(second.cookie)), /Phiên đăng nhập/);
      await source.getRepository(SessionEntity).delete(claims.sid);
      await assert.rejects(auth.authenticate(request(second.cookie)), /Phiên đăng nhập/);
      await auth.authenticate(request(cookies.admin));
    });
    const template = (await source.getRepository(ProductEntity).find({ take: 1 }))[0];
    await source.getRepository(ProductEntity).clear();
    await source.getRepository(OrderEntity).clear(); await source.getRepository(ReceiptEntity).clear();
    await source.getRepository(LedgerEntity).clear();
    const products = Array.from({ length: 75 }, (_, i) => {
      const id = `performance-${String(i).padStart(3, "0")}`;
      return { id, slug: id, published: i !== 74, data: { ...template.data, id, slug: id, code: `PERF-${i}`, name: `Sản phẩm ${String(i).padStart(3, "0")}`, stock: 50, brand: "HAFELE", description: "D".repeat(20000), technicalDetails: "T".repeat(20000), gallery: Array(20).fill("/media/uploads/long-gallery.webp") } };
    });
    await source.getRepository(ProductEntity).save(products);
    const branch = "Quy Nhơn", qs = values => new URLSearchParams({ branch, ...values });
    const customer = { id: "performance-customer", branch, name: "Khách thử nghiệm", contact: "QA", phone: "0901234567", group: "Xưởng nội thất", status: "Đang hoạt động", limit: 100000, debt: 1000, overdue: 10 };
    await source.getRepository(CustomerEntity).save([{ id: customer.id, branch, data: customer }, { id: "negative", branch, data: { ...customer, id: "negative", name: "Số dư âm", debt: -50 } }, { id: "other", branch: "Tuy Hòa", data: { ...customer, id: "other", branch: "Tuy Hòa" } }]);
    await source.getRepository(CreditEntity).save({ customerId: customer.id, branch, openingDebt: 1000, openingOverdue: 10, debt: 750 });
    const date = businessDate(), ago = days => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
    const createOrder = async (id, changes = {}, dueDate = null, orderBranch = branch) => {
      const data = { id, branch: orderBranch, date, customerId: customer.id, customerName: customer.name, channel: "B2B", source: "Website B2B", status: "Hoàn tất", credit: true, total: 100, items: [{ productId: products[0].id, quantity: 3, unitPrice: 100 / 3 }], ...changes };
      const row = await source.getRepository(OrderEntity).save({ id, branch: orderBranch, customerId: data.customerId, data, dueDate, checkout: null, createdAt: new Date(`${date}T01:00:00Z`), warehouse: { checks: {}, history: [{ label: "Chờ soạn hàng", at: `${date}T01:10:00Z` }] } });
      return row;
    };
    const agingOrders = [];
    for (const [index, days] of [-5, 10, 40, 70, 100, null].entries()) {
      const row = await createOrder(`aging-${index}`, { date: ago(150) }, days === null ? null : ago(days)); agingOrders.push(row);
      await source.getRepository(LedgerEntity).save({ branch, kind: "credit", resourceId: customer.id, delta: 100, reference: `order:${row.id}:credit`, actorId: admin.id, reason: "QA" });
    }
    await source.getRepository(ReceiptEntity).save([
      { id: "paid", branch, data: { id: "paid", branch, orderId: agingOrders[1].id, amount: 25, status: "Đã đối chiếu" } },
      { id: "pending", branch, data: { id: "pending", branch, orderId: agingOrders[2].id, amount: 80, status: "Chờ đối chiếu" } },
      { id: "void", branch, data: { id: "void", branch, orderId: agingOrders[3].id, amount: 90, status: "Đã hủy" } },
    ]);
    const editing = await createOrder("editing", { status: "Chờ xác nhận", source: "Zalo" });
    await createOrder("reserved", { status: "Đang soạn" });
    await createOrder("cancelled", { status: "Đã hủy", cancelReason: "Khách đổi ý" });
    await createOrder("other-branch", {}, null, "Tuy Hòa");
    await source.getRepository(InventoryEntity).save({ id: `${branch}:${products[0].id}`, branch, productId: products[0].id, onHand: 30 });
    await t.test("Product pages omit repeated metadata and react to metadata changes across instances", async () => {
      queries.length = 0;
      const page = await browse.browse(admin, { branch, resource: "products", metadata: false, page: 1, pageSize: 10 });
      assert.equal(page.products.length, 10); assert.equal(page.categories, undefined); assert.equal(page.brands, undefined);
      assert.equal(queries.length, 4); assert.ok(page.products.every(row => !row.description && !row.technicalDetails && row.gallery.length === 0));
      const metadata = await browse.productMetadata(admin, branch);
      queries.length = 0; assert.deepEqual(await browse.productMetadata(admin, branch), metadata); assert.equal(queries.length, 1);
      await source.getRepository(ProductEntity).update(products[0].id, { data: { ...products[0].data, brand: "New Brand" } });
      assert.ok((await browse.productMetadata(admin, branch)).brands.includes("New Brand"));
      const category = (await source.getRepository(CategoryEntity).find({ take: 1 }))[0];
      await source.getRepository(CategoryEntity).update(category.slug, { data: { ...category.data, name: "Tên danh mục mới" } });
      assert.equal((await browse.productMetadata(admin, branch)).categories.find(item => item.slug === category.slug).name, "Tên danh mục mới");
      const invalid = await call(`/admin/browse?${qs({ resource: "products", metadata: "invalid" })}`, cookies.admin); assert.equal(invalid.status, 400);
    });
    await t.test("Order editor returns only selected order/SKUs; picker is paged and permissions stay scoped", async () => {
      assert.equal((await call("/auth/session", cookies.kh001)).status, 200, "B2B session is valid before testing staff-only authorization");
      const result = await call(`/admin/order-editor?${qs({ id: editing.id })}`, cookies.admin);
      assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(result.data.orders.map(row => row.id), [editing.id]);
      assert.deepEqual(result.data.products.map(row => row.id), [products[0].id]);
      assert.ok(result.data.customers.every(row => row.branch === branch)); assert.equal(result.data.products[0].description, undefined);
      const blank = await call(`/admin/order-editor?${qs({})}`, cookies.admin); assert.equal(blank.data.products.length, 0); assert.equal(blank.data.orders.length, 0);
      for (const role of ["warehouse", "accountant", "kh001"]) assert.equal((await call(`/admin/order-editor?${qs({})}`, cookies[role])).status, 403);
      assert.equal((await call(`/admin/order-editor?${qs({ id: "other-branch" })}`, cookies.admin)).status, 404);
      assert.equal((await call(`/admin/order-editor?${new URLSearchParams({ branch: "Tuy Hòa" })}`, cookies.sales)).status, 403);
      const picker = await call(`/admin/browse?${qs({ resource: "products", metadata: "false", status: "published", page: "2", pageSize: "10" })}`, cookies.admin);
      assert.equal(picker.data.products.length, 10); assert.equal(picker.data.pagination.total, 74); assert.ok(picker.data.products.every(row => row.published));
      assert.ok(bytes(result.data) < 30000); assert.ok(bytes(picker.data) < 30000);
      const legacy = await call(`/admin/resources?${qs({ include: "products,orders,customers,approvals,categories" })}`, cookies.admin);
      assert.equal(legacy.status, 200); assert.ok(bytes(blank.data) < bytes(legacy.data) / 30);
      t.diagnostic(`Order initial JSON: ${bytes(legacy.data)} -> ${bytes(blank.data)} bytes on 75 large-content SKUs`);
    });
    await t.test("Ledger pages preserve stock, credit, search, branch isolation and warehouse redaction", async () => {
      const stock = await call(`/admin/ledger/page?${qs({ tab: "stock", q: "san pham 000" })}`, cookies.admin);
      assert.equal(stock.status, 200, JSON.stringify(stock.data)); assert.equal(stock.data.pagination.total, 1);
      assert.equal(stock.data.inventory[0].onHand, 30); assert.equal(stock.data.inventory[0].reserved, 3); assert.equal(stock.data.inventory[0].stock, 27);
      assert.equal(stock.data.inventory[0].description, undefined); assert.equal(stock.data.customers.length, 0);
      const last = await call(`/admin/ledger/page?${qs({ page: "999" })}`, cookies.admin); assert.equal(last.data.pagination.page, 8); assert.equal(last.data.inventory.length, 5);
      const empty = await call(`/admin/ledger/page?${qs({ q: "no-matching-product" })}`, cookies.admin); assert.equal(empty.data.pagination.total, 0);
      const credits = await call(`/admin/ledger/page?${qs({ tab: "credit" })}`, cookies.admin);
      const expected = await ledger.customers([customer]); const credit = credits.data.customers.find(row => row.id === customer.id);
      assert.equal(credit.debt, expected[0].debt); assert.equal(credit.overdue, expected[0].overdue); assert.equal(credit.creditReserved, 100);
      assert.equal((await call(`/admin/ledger/page?${qs({ tab: "credit" })}`, cookies.warehouse)).status, 403);
      const warehouse = await call(`/admin/ledger/page?${qs({ tab: "stock" })}`, cookies.warehouse); assert.equal(warehouse.status, 200); assert.equal(warehouse.data.inventory[0].price, undefined);
      const history = await call(`/admin/ledger/page?${qs({ tab: "entries" })}`, cookies.warehouse); assert.ok(history.data.entries.every(row => row.kind === "stock"));
      for (const values of [{ pageSize: "1000" }, { tab: "unknown" }, { branch: "invalid" }]) assert.equal((await call(`/admin/ledger/page?${qs(values)}`, cookies.admin)).status, 400);
      assert.equal((await call(`/admin/ledger/page?${qs({})}`)).status, 401);
      assert.equal((await call(`/admin/ledger/page?${qs({})}`, cookies.kh001)).status, 403);
      const fresh = await call(`/admin/ledger/page?${qs({})}`, cookies.admin);
      const legacy = await call(`/admin/ledger?${qs({})}`, cookies.admin);
      assert.ok(bytes(fresh.data) < bytes(legacy.data) / 100);
      t.diagnostic(`Ledger initial JSON: ${bytes(legacy.data)} -> ${bytes(fresh.data)} bytes on 75 large-content SKUs`);
    });
    await t.test("Reports use three projected reads and preserve all-time aging and period metrics", async () => {
      const controller = new ReportsController(db, { authenticate: async () => admin }, ledger, {});
      queries.length = 0;
      const report = await controller.report({}, branch, "30"); assert.equal(queries.length, 3);
      assert.equal(report.orders, 3); assert.equal(report.b2bOrders, 3); assert.equal(report.selfOrders, 2); assert.equal(report.confirmationMinutes, 10);
      assert.deepEqual(report.cancelledOrders, [{ id: "cancelled", reason: "Khách đổi ý" }]);
      const aged = report.aging.find(row => row.id === customer.id);
      assert.deepEqual(aged, { id: customer.id, name: customer.name, debt: 750, overdue: 385, current: 100, days30: 75, days60: 100, days90: 100, older: 100, unknown: 275 });
      const negative = report.aging.find(row => row.id === "negative"); assert.equal(negative.debt, -50); assert.equal(negative.overdue, 0);
      const rows = await source.getRepository(OrderEntity).find({ where: { branch } });
      const receipts = (await source.getRepository(ReceiptEntity).find({ where: { branch } })).filter(row => row.data.status === "Đã đối chiếu");
      const entries = await source.getRepository(LedgerEntity).find({ where: { branch, kind: "credit" } });
      // Independent legacy allocation, including all orders outside the report period.
      const amounts = { current: 0, days30: 0, days60: 0, days90: 0, older: 0, unknown: 0 }; let remaining = 750;
      for (const row of rows.filter(row => row.customerId === customer.id && entries.some(entry => entry.reference === `order:${row.id}:credit`)).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))) {
        const paid = receipts.filter(receipt => receipt.data.orderId === row.id).reduce((sum, row) => sum + row.data.amount, 0);
        const posted = entries.find(entry => entry.reference === `order:${row.id}:credit`).delta;
        const unpaid = Math.min(remaining, Math.max(0, posted - paid)); amounts[agingBucket(row.dueDate, date)] += unpaid; remaining -= unpaid;
      }
      amounts.unknown += remaining;
      for (const [key, value] of Object.entries(amounts)) assert.equal(aged[key], value);
      for (const role of ["warehouse", "kh001"]) assert.equal((await call(`/admin/reports?${qs({ days: "30" })}`, cookies[role])).status, 403);
    });
    await t.test("Live stock changes are visible and warehouse details hide financial data", async () => {
      await source.getRepository(InventoryEntity).update(`${branch}:${products[0].id}`, { onHand: 40 });
      const detail = await call(`/admin/orders/reserved?${qs({})}`, cookies.warehouse);
      assert.equal(detail.status, 200); assert.equal(detail.data.products[0].stock, 37); assert.equal(detail.data.orders[0].total, 0);
      assert.equal(detail.data.orders[0].items[0].unitPrice, 0); assert.deepEqual(detail.data.customers, []); assert.deepEqual(detail.data.receipts, []);
      assert.equal((await call(`/admin/orders/cancelled?${qs({})}`, cookies.warehouse)).status, 404);
    });
  } finally {
    if (source?.isInitialized) await source.destroy();
    if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await database.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
