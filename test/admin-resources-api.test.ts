import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import { DataSource } from "typeorm";
import { DatabaseService } from "../dist/database/database.service";
import { entities, UserEntity, ProductEntity, OrderEntity, ApprovalEntity } from "../dist/database/entities";
import { AdminService } from "../dist/admin/admin.service";
import { LedgerService } from "../dist/ledger/ledger.service";
import { PricePolicyService } from "../dist/catalog/price-policy.service";
import { NotificationsService } from "../dist/notifications/notifications.service";
import { AdminBrowseService } from "../dist/admin/admin-browse.service";
import { businessDate } from "../dist/orders/orders.service";

config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Admin resource QA only targets local PostgreSQL.");
const base = "http://127.0.0.1:4010/api";
const resourcePath = (include: string, branch = "Quy Nhơn") => `/admin/resources?${new URLSearchParams({ branch, include })}`;
class Actor {
  cookies = new Map<string, string>();
  async call(path: string, method = "GET", body?: object) {
    const response = await fetch(base + path, { method, headers: { Origin: "http://localhost:3010", "X-BaoTin-Client": "web", Cookie: Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; "), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const cookie of response.headers.getSetCookie()) { const [name, ...value] = cookie.split(";")[0].split("="); this.cookies.set(name, value.join("=")); }
    return { status: response.status, data: await response.json() };
  }
}

test("Scoped admin resources and compact commands", { timeout: 120000 }, async t => {
  const schema = `admin_resources_qa_${randomBytes(5).toString("hex")}`;
  const password = `QA-${randomBytes(20).toString("hex")}`;
  const sql = new Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
  const child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, ENV_FILE: ".env.local", DB_SCHEMA: schema, PORT: "4010", HOST: "127.0.0.1", DB_SYNCHRONIZE: "true", DB_SSL: "false", NODE_ENV: "development", COOKIE_SECURE: "false", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, FRONTEND_ORIGINS: "http://localhost:3010", KIOTVIET_ENABLED: "false", SMTP_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  const guest = new Actor(), admin = new Actor(), warehouse = new Actor(), sales = new Actor(), b2b = new Actor();
  const db = new DatabaseService();
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(logs);
      if (await fetch(base + "/health").then(response => response.ok).catch(() => false)) break;
      if (attempt === 149) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const [actor, identity] of [[admin, "admin"], [warehouse, "warehouse"], [sales, "sales"], [b2b, "kh001"]] as const) assert.equal((await actor.call("/auth/login", "POST", { identity: `${identity}@baotin.local`, password })).status, 201);
    await sql.query(`UPDATE "${schema}".users SET branches='Quy Nhơn' WHERE email='sales@baotin.local'`);
    db.source = new DataSource({ type: "postgres", url: process.env.DATABASE_URL, schema, entities, synchronize: false, ssl: false });
    await db.source.initialize();
    const service = new AdminService(db, new PricePolicyService(db), new LedgerService(db), new NotificationsService(db));
    const user = await db.source.getRepository(UserEntity).findOneByOrFail({ email: "admin@baotin.local" });
    const queries: string[] = [];
    db.source.logger.logQuery = query => { queries.push(query); };
    await t.test("Products do not read customer finance, receipts or approvals", async () => {
      queries.length = 0;
      const data = await service.resources(user, { branch: "Quy Nhơn", include: ["products", "categories"] });
      assert.deepEqual(Object.keys(data).sort(), ["products", "categories", "stockByBranch", "today"].sort());
      assert.equal(queries.length, 4, queries.join("\n"));
      for (const table of ["customers", "credit_balances", "ledger_entries", "receipts", "approvals"]) assert.ok(!queries.some(query => query.includes(`"${schema}"."${table}"`)), table);
      assert.deepEqual(Object.keys(data.stockByBranch!), ["Quy Nhơn"]);
    });
    await t.test("Each resource returns only its fields, with branch filtering in SQL", async () => {
      for (const include of ["orders", "customers", "approvals", "receipts"] as const) {
        const result = await admin.call(resourcePath(include));
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(result.data.products, undefined);
        assert.ok(result.data[include].every((row: { branch: string }) => row.branch === "Quy Nhơn"));
      }
      queries.length = 0;
      await service.resources(user, { branch: "Tuy Hòa", include: ["orders"] });
      assert.equal(queries.length, 2);
      assert.ok(queries.every(query => query.includes('"branch" IN')));
    });
    await t.test("Authentication, branch grants and query validation cannot be bypassed", async () => {
      assert.equal((await guest.call(resourcePath("products"))).status, 401);
      assert.equal((await b2b.call(resourcePath("products"))).status, 403);
      assert.equal((await sales.call(resourcePath("orders", "Tuy Hòa"))).status, 403);
      for (const suffix of ["include=unknown&branch=Quy%20Nhơn", "include=products", "include=&branch=Quy%20Nhơn", "include=products&branch=invalid", "include=products&branch=Quy%20Nhơn&unknown=1"]) assert.equal((await admin.call("/admin/resources?" + suffix)).status, 400, suffix);
    });
    await t.test("Warehouse resources still redact finances and expose only active warehouse orders", async () => {
      const result = await warehouse.call(resourcePath("orders,products,customers,approvals,receipts"));
      assert.equal(result.status, 200);
      assert.ok(result.data.orders.length > 0);
      assert.ok(result.data.orders.every((row: { status: string; total: number; items: { unitPrice: number }[] }) => ["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao"].includes(row.status) && row.total === 0 && row.items.every(item => item.unitPrice === 0)));
      assert.ok(result.data.products.every((row: { price: number }) => row.price === 0));
      assert.ok(result.data.customers.every((row: { debt: number; limit: number }) => row.debt === 0 && row.limit === 0));
      assert.deepEqual(result.data.approvals, []); assert.deepEqual(result.data.receipts, []); assert.deepEqual(result.data.paymentDueDates, {});
    });
    await t.test("Compact commands skip the full response; subsequent targeted reads see the committed update", async () => {
      const before = (await admin.call(resourcePath("customers"))).data.customers[0];
      const result = await admin.call("/admin/commands", "POST", { action: "customer-status", branch: before.branch, id: before.id, payload: { status: "Tạm ngưng", revision: before.revision }, returnState: false });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.deepEqual(result.data, { id: before.id });
      const after = (await admin.call(resourcePath("customers"))).data.customers.find((row: { id: string }) => row.id === before.id);
      assert.equal(after.status, "Tạm ngưng"); assert.equal(after.revision, before.revision + 1);
      assert.equal((await admin.call("/admin/commands", "POST", { action: "customer-status", branch: before.branch, id: before.id, payload: { status: "Đang hoạt động", revision: before.revision }, returnState: false })).status, 409);
      const legacy = await admin.call("/admin/commands", "POST", { action: "customer-status", branch: before.branch, id: before.id, payload: { status: "Đang hoạt động", revision: after.revision } });
      assert.equal(legacy.status, 201); assert.ok(legacy.data.state.products.length > 0);
    });
    const browsePath = (resource: string, values: Record<string, string> = {}) => `/admin/browse?${new URLSearchParams({ resource, branch: "Quy Nhơn", ...values })}`;
    await t.test("Browse validates queries, branch grants and financial redaction", async () => {
      assert.equal((await guest.call(browsePath("products"))).status, 401);
      assert.equal((await b2b.call(browsePath("products"))).status, 403);
      assert.equal((await sales.call(browsePath("orders", { branch: "Tuy Hòa" }))).status, 403);
      for (const query of [{ page: "0" }, { pageSize: "1000" }, { from: "2026-99-01" }, { from: "2026-10-12", to: "2026-10-01" }, { unexpected: "1" }]) assert.equal((await admin.call(browsePath("orders", query))).status, 400);
      const result = await warehouse.call(browsePath("orders"));
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.ok(result.data.orders.every((row: { total: number }) => row.total === 0));
      assert.equal((await warehouse.call(browsePath("customers"))).status, 403);
      assert.equal((await warehouse.call(`/admin/dashboard?${new URLSearchParams({ branch: "Quy Nhơn" })}`)).status, 403);
    });
    await t.test("Product pages are SQL bounded, searchable without accents and stable", async () => {
      const sample = await db.source.getRepository(ProductEntity).findOneByOrFail({ id: "LED-12V-8W" });
      const longContent = "Nội dung dài không dùng trong danh sách. ".repeat(1000);
      await db.source.getRepository(ProductEntity).insert(Array.from({ length: 55 }, (_, index) => ({ id: `browse-qa-${index}`, slug: `browse-qa-${index}`, data: { ...sample.data, id: `browse-qa-${index}`, code: `BROWSE-${index}`, name: `Sản phẩm phân trang QA ${String(index).padStart(3, "0")}`, subcategory: index % 2 === 0 ? "Nhóm QA A" : "Nhóm QA B", description: longContent, technicalDetails: longContent, usageGuide: longContent }, published: index % 2 === 0 })));
      const first = await admin.call(browsePath("products", { q: "san pham phan trang QA", pageSize: "10" }));
      const second = await admin.call(browsePath("products", { q: "san pham phan trang QA", page: "2", pageSize: "10" }));
      assert.equal(first.status, 200, JSON.stringify(first.data));
      assert.equal(first.data.pagination.total, 55); assert.equal(first.data.products.length, 10);
      assert.equal(second.data.products.length, 10);
      assert.ok(!second.data.products.some((row: { id: string }) => first.data.products.some((item: { id: string }) => item.id === row.id)));
      assert.ok(first.data.products.every((row: Record<string, unknown>) => row.description === undefined && row.technicalDetails === undefined && row.usageGuide === undefined));
      assert.equal((await db.source.getRepository(ProductEntity).findOneByOrFail({ id: "browse-qa-0" })).data.description, longContent);
      assert.ok(JSON.stringify(first.data).length < 50000);
      const grouped = await admin.call(browsePath("products", { q: "san pham phan trang QA", category: sample.data.category, subcategory: "Nhóm QA A", status: "published" }));
      assert.equal(grouped.status, 200, JSON.stringify(grouped.data)); assert.equal(grouped.data.pagination.total, 28);
      assert.ok(grouped.data.products.every((row: { category: string; subcategory: string }) => row.category === sample.data.category && row.subcategory === "Nhóm QA A"));
      const last = await admin.call(browsePath("products", { q: "san pham phan trang QA", page: "999" }));
      assert.equal(last.data.pagination.page, 6); assert.equal(last.data.products.length, 5);
      assert.equal((await admin.call(browsePath("products", { q: "BROWSE-54", status: "published" }))).data.pagination.total, 1);
      const browse = new AdminBrowseService(db, new LedgerService(db));
      queries.length = 0;
      await browse.browse(user, { resource: "products", branch: "Quy Nhơn", page: 1, pageSize: 10 });
      assert.ok(queries.some(query => /FROM .*products.*LIMIT 10/.test(query)), queries.join("\n"));
      assert.ok(!queries.some(query => query.includes('"customers"')));
      assert.equal(queries.filter(query => query.includes('"categories"')).length, 1);
    });
    await t.test("All-time order search and targeted details include pending orders older than 90 days", async () => {
      const repository = db.source.getRepository(OrderEntity);
      const sample = (await repository.find())[0];
      await repository.insert({ id: "QA-OLD-90", branch: "Quy Nhơn", customerId: sample.customerId, data: { ...sample.data, id: "QA-OLD-90", branch: "Quy Nhơn", date: "2026-01-01", status: "Chờ xác nhận" }, warehouse: { checks: {}, history: [] } });
      const all = await admin.call(browsePath("orders", { q: "QA-OLD-90" }));
      assert.equal(all.status, 200, JSON.stringify(all.data)); assert.equal(all.data.orders[0].id, "QA-OLD-90");
      assert.equal((await admin.call(browsePath("orders", { q: "QA-OLD-90", from: "2026-10-01" }))).data.pagination.total, 0);
      const detail = await admin.call(`/admin/orders/QA-OLD-90?${new URLSearchParams({ branch: "Quy Nhơn" })}`);
      assert.equal(detail.status, 200, JSON.stringify(detail.data)); assert.equal(detail.data.orders.length, 1);
      assert.ok(detail.data.products.length <= sample.data.items.length);
      assert.equal((await admin.call(`/admin/orders/QA-OLD-90?${new URLSearchParams({ branch: "Tuy Hòa" })}`)).status, 404);
      assert.equal((await warehouse.call(`/admin/orders/QA-OLD-90?${new URLSearchParams({ branch: "Quy Nhơn" })}`)).status, 404);
    });
    await t.test("Warehouse search retains SKU lookup and counts the whole branch", async () => {
      const legacy = (await warehouse.call(resourcePath("orders"))).data.orders;
      const first = legacy[0];
      const product = await db.source.getRepository(ProductEntity).findOneByOrFail({ id: first.items[0].productId });
      const response = await warehouse.call(browsePath("warehouse", { q: product.data.code }));
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.ok(response.data.orders.some((order: { id: string }) => order.id === first.id));
      assert.equal(response.data.warehouseSummary.total, legacy.length);
      assert.equal(response.data.warehouseSummary.waiting + response.data.warehouseSummary.picking + response.data.warehouseSummary.ready, legacy.length);
      assert.ok(response.data.orders.every((order: { total: number }) => order.total === 0));
    });
    await t.test("Customer pages combine directory and authoritative finance without duplicate list reads", async () => {
      const legacy = (await admin.call(resourcePath("customers"))).data.customers;
      for (const status of ["all", "overdue", "overlimit"]) {
        const response = await admin.call(browsePath("customers", { status }));
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.ok(response.data.customers.length <= 10);
        for (const customer of response.data.customers) {
          const existing = legacy.find((row: { id: string }) => row.id === customer.id);
          assert.equal(customer.debt, existing.debt); assert.equal(customer.overdue, existing.overdue);
          assert.equal(typeof customer.revision, "number");
          if (status === "overdue") assert.ok(customer.overdue > 0);
          if (status === "overlimit") assert.ok(customer.debt > customer.limit);
        }
        assert.deepEqual(response.data.directory.items, response.data.customers);
        assert.ok(response.data.directory.assignees.every((row: { name: string }) => typeof row.name === "string"));
      }
    });
    await t.test("Dashboard returns summaries and at most five recent orders, with all-time pending queues", async () => {
      const legacy = (await admin.call(resourcePath("orders,customers,approvals"))).data;
      const response = await admin.call(`/admin/dashboard?${new URLSearchParams({ branch: "Quy Nhơn", days: "90" })}`);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.today, businessDate());
      assert.ok(response.data.recentOrders.length <= 5);
      assert.equal(response.data.products, undefined); assert.equal(response.data.customers, undefined);
      assert.equal(response.data.metrics.pendingOrders, legacy.orders.filter((row: { status: string }) => row.status === "Chờ xác nhận").length);
      assert.equal(response.data.metrics.debt, legacy.customers.reduce((sum: number, row: { debt: number }) => sum + row.debt, 0));
      const period = legacy.orders.filter((row: { date: string; status: string }) => row.date.slice(0, 10) >= response.data.since && row.date.slice(0, 10) <= response.data.today && row.status !== "Đã hủy");
      assert.equal(response.data.metrics.total, period.reduce((sum: number, row: { total: number }) => sum + row.total, 0));
      assert.equal(response.data.periods[0].start, response.data.since);
      assert.equal(response.data.periods.at(-1).end, response.data.today);
      assert.equal(response.data.periods.reduce((sum: number, row: { value: number }) => sum + row.value, 0), response.data.metrics.total);
    });
    await t.test("Dashboard SQL matches approved price snapshots, stale approvals and website coupons", async () => {
      const orders = db.source.getRepository(OrderEntity), approvals = db.source.getRepository(ApprovalEntity);
      const sample = await orders.findOneByOrFail({ branch: "Quy Nhơn", customerId: "KH001" });
      const id = "QA-DASHBOARD-PRICE";
      const data = { ...sample.data, id, date: businessDate(), status: "Chờ xác nhận" as const };
      const row = await orders.save(orders.create({ ...sample, id, checkout: null, data }));
      const lines = data.items.map(line => ({ ...line, requestedPrice: Math.max(1, Math.floor(line.unitPrice * 0.8)) }));
      const discounted = lines.reduce((sum, line) => sum + line.quantity * line.requestedPrice, 0);
      const approval = await approvals.save(approvals.create({ id: "QA-DASHBOARD-APPROVAL", branch: row.branch, data: { id: "QA-DASHBOARD-APPROVAL", orderId: id, customerId: "KH001", branch: row.branch, type: "Giá đặc biệt", status: "Đã duyệt", requestedBy: "QA", reason: "Disposable fixture", createdAt: new Date().toISOString(), snapshot: { kind: "price", lines, total: data.total, requestedTotal: discounted } } }));
      const summary = async () => {
        const response = await admin.call("/admin/dashboard?branch=Quy+Nh%C6%A1n&days=7");
        assert.equal(response.status, 200, JSON.stringify(response.data));
        const legacy = (await admin.call(resourcePath("orders,approvals"))).data.orders;
        const expected = legacy.filter((order: { date: string; status: string }) => order.date >= response.data.since && order.date <= response.data.today && order.status !== "Đã hủy").reduce((sum: number, order: { total: number }) => sum + order.total, 0);
        assert.equal(response.data.metrics.total, expected);
        return (await admin.call(`/admin/orders/${id}?branch=Quy+Nh%C6%A1n`)).data.orders[0].total;
      };
      assert.equal(await summary(), discounted);
      row.checkout = { id, customerId: "KH001", date: data.date, status: "Chờ xác nhận", b2b: true, items: data.items, subtotal: data.total, shipping: 30000, discount: 1, coupon: "BAOTIN10", total: data.total, customer: { name: "QA", phone: "0901234567", email: "", address: "QA", city: "", district: "", ward: "" }, delivery: "Giao nội thành", payment: "Tiền mặt", note: "" };
      await orders.save(row);
      assert.equal(await summary(), discounted + 30000 - Math.min(100000, Math.round(discounted * 0.1)));
      if (approval.data.snapshot?.kind === "price") approval.data.snapshot.lines[0].quantity++;
      await approvals.save(approval);
      const retail = data.items.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
      assert.equal(await summary(), retail + 30000 - Math.min(100000, Math.round(retail * 0.1)));
      await approvals.delete(approval.id); await orders.delete(id);
    });
    await t.test("Quotes accept pricing-only fields but saving still requires valid contact details", async () => {
      const product = (await admin.call(browsePath("products"))).data.products.find((product: { published: boolean }) => product.published);
      const draft = { branch: "Quy Nhơn", customerId: "", source: "Zalo", items: [{ productId: product.id, quantity: 2 }], details: { delivery: "Nhận tại cửa hàng", payment: "Chuyển khoản" } };
      const quote = await sales.call("/admin/orders/quote", "POST", draft);
      assert.equal(quote.status, 201, JSON.stringify(quote.data));
      assert.equal(quote.data.total, product.price * 2);
      assert.equal((await warehouse.call("/admin/orders/quote", "POST", draft)).status, 403);
      const { branch, ...payload } = draft;
      assert.equal((await admin.call("/admin/commands", "POST", { action: "save-order", branch, payload, returnState: false })).status, 400);
      assert.equal((await admin.call("/admin/commands", "POST", { action: "save-order", branch, payload: { ...payload, details: { ...payload.details, recipient: "QA", phone: "abcdefghi", address: "", note: "" } }, returnState: false })).status, 400);
      assert.equal((await admin.call("/admin/orders/quote", "POST", { ...draft, details: { ...draft.details, payment: "Công nợ B2B" } })).status, 400);
      assert.equal((await admin.call("/admin/orders/quote", "POST", { ...draft, items: [...draft.items, ...draft.items] })).status, 400);
    });
    await t.test("Measure full state versus scoped payloads on local fixtures", async () => {
      const measurements: { endpoint: string; ms: number; bytes: number }[] = [];
      for (const endpoint of ["/admin/state", browsePath("orders"), browsePath("products"), browsePath("customers"), "/admin/dashboard?branch=Quy+Nh%C6%A1n&days=7"]) {
        const start = performance.now(); const response = await admin.call(endpoint);
        assert.equal(response.status, 200);
        measurements.push({ endpoint, ms: Math.round(performance.now() - start), bytes: Buffer.byteLength(JSON.stringify(response.data)) });
      }
      t.diagnostic(JSON.stringify(measurements));
      assert.ok(measurements[1].bytes < measurements[0].bytes);
      assert.ok(measurements[2].bytes < measurements[0].bytes);
    });
  } finally {
    if (db.source?.isInitialized) await db.source.destroy();
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end();
  }
});
