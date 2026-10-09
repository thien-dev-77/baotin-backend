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
import { entities, UserEntity } from "../dist/database/entities";
import { AdminService } from "../dist/admin/admin.service";
import { LedgerService } from "../dist/ledger/ledger.service";
import { PricePolicyService } from "../dist/catalog/price-policy.service";
import { NotificationsService } from "../dist/notifications/notifications.service";

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
    await t.test("Measure full state versus scoped payloads on local fixtures", async () => {
      const measurements: { endpoint: string; ms: number; bytes: number }[] = [];
      for (const endpoint of ["/admin/state", resourcePath("orders,customers,approvals"), resourcePath("products,categories")]) {
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
