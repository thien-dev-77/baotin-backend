import test from "node:test";
import assert from "node:assert/strict";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";

config({ path: ".env.local", quiet: true });
const base = process.env.QA_API_URL || "http://127.0.0.1:4000/api";
const origin = "http://localhost:3010";
const schema = process.env.DB_SCHEMA || "baotin_app";
const password = process.env.SEED_PASSWORD!;
if (!base.startsWith("http://127.0.0.1:") || !process.env.DATABASE_URL?.includes("127.0.0.1")) throw new Error("Tests only target the local test database.");

class Actor {
  cookies = new Map<string, string>();
  async call(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { Origin: origin, "X-BaoTin-Client": "web", Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(";")[0]; const index = pair.indexOf("="); this.cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
    const data = await response.json();
    return { response, data };
  }
  async login(name: string) { const result = await this.call("/auth/login", "POST", { identity: `${name}@baotin.local`, password }); assert.equal(result.response.status, 201, `Login ${name}`); return result; }
}

test("Connected API: auth, ownership, server prices, Sales, approvals, warehouse, receipts and media", async (t) => {
  const sql = new Client({ connectionString: process.env.DATABASE_URL }); await sql.connect();
  const guest = new Actor(), otherGuest = new Actor(), admin = new Actor(), sales = new Actor(), warehouse = new Actor(), accountant = new Actor(), b2b = new Actor(), pending = new Actor();
  const orderIds: string[] = [], receiptIds: string[] = [], approvalIds: string[] = [];
  let registeredId = "", customerId = "", uploaded = "", originalProduct: unknown, originalProfile: unknown, leadId = "", newsletterEmail = "";
  const productId = "LED-12V-8W";
  try {
    const catalog = (await guest.call("/catalog")).data;
    assert.equal(catalog.products.length, 63); assert.equal(catalog.categories.length, 8);
    const product = catalog.products.find((item: { id: string }) => item.id === productId);
    await t.test("Public images render and financial prices are not personalized for guests", async () => {
      assert.ok(!catalog.products.some((item: { customerPrice?: number }) => item.customerPrice !== undefined));
      for (const path of new Set<string>(catalog.products.map((item: { image: string }) => item.image))) {
        const image = await fetch(`${base.replace("/api", "")}/media/${path.replace(/^\/images\//, "images/")}`);
        assert.equal(image.status, 200, path); assert.ok(image.headers.get("content-type")?.startsWith("image/"));
      }
      assert.equal((await guest.call("/admin/state")).response.status, 401);
    });
    const authResult = await admin.login("admin");
    await sales.login("sales"); await warehouse.login("warehouse"); await accountant.login("accountant"); await b2b.login("kh001");
    await t.test("JWT cookies, role/branch guards and CSRF", async () => {
      assert.ok(authResult.response.headers.getSetCookie().some((cookie) => cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax")));
      assert.equal((await guest.call("/auth/login", "POST", { identity: "admin@baotin.local", password: "wrong-password" })).response.status, 401);
      assert.equal((await b2b.call("/admin/state")).response.status, 403);
      assert.equal((await sales.call("/admin/commands", "POST", { action: "customer-status", branch: "Tuy Hòa", id: "KH005", payload: { status: "Tạm ngưng" } })).response.status, 403);
      assert.equal((await sales.call("/admin/commands", "POST", { action: "create-receipt", branch: "Quy Nhơn", payload: {} })).response.status, 403);
      assert.equal((await guest.call("/orders/quote", "POST", { items: [{ productId, quantity: 1 }], delivery: "Nhận tại cửa hàng", coupon: "" }, { Origin: "https://untrusted.example" })).response.status, 403);
      const view = (await warehouse.call("/admin/state")).data;
      assert.ok(view.orders.every((order: { total: number }) => order.total === 0)); assert.equal(view.approvals.length, 0);
    });
    const body = { items: [{ productId, quantity: 1 }], customer: { name: "API test buyer", phone: "0901234567", email: "", address: "", city: "", district: "", ward: "" }, delivery: "Nhận tại cửa hàng", payment: "Thanh toán khi nhận hàng (COD)", note: "API integration test", coupon: "" };
    await guest.call("/orders");
    await t.test("Server quote, input validation, idempotency and guest ownership", async () => {
      const quote = (await guest.call("/orders/quote", "POST", bodyQuote(body))).data;
      assert.equal(quote.total, product.price);
      assert.equal((await guest.call("/orders/quote", "POST", { ...bodyQuote(body), total: 1 })).response.status, 400);
      assert.equal((await guest.call("/orders", "POST", { ...body, customer: undefined }, { "Idempotency-Key": randomUUID() })).response.status, 400);
      assert.equal((await guest.call("/orders", "POST", { ...body, expectedTotal: 1 }, { "Idempotency-Key": randomUUID() })).response.status, 409);
      const key = randomUUID();
      const results = await Promise.all([guest.call("/orders", "POST", body, { "Idempotency-Key": key }), guest.call("/orders", "POST", body, { "Idempotency-Key": key })]);
      assert.equal(results[0].response.status, 201); assert.equal(results[0].data.id, results[1].data.id);
      orderIds.push(results[0].data.id);
      assert.equal((await guest.call("/orders", "POST", { ...body, note: "changed" }, { "Idempotency-Key": key })).response.status, 409);
      assert.ok((await guest.call("/orders")).data.some((item: { id: string }) => item.id === orderIds[0]));
      assert.ok(!(await otherGuest.call("/orders")).data.some((item: { id: string }) => item.id === orderIds[0]));
      const tampered = new Actor(); tampered.cookies.set("baotin_session", "invalid-token");
      assert.equal((await tampered.call("/orders/quote", "POST", bodyQuote(body))).response.status, 401);
    });
    await t.test("Registration cannot assign roles or credit; pending account cannot buy B2B", async () => {
      const registration = { name: "Test user", company: "Integration test", email: `test-${randomUUID()}@example.com`, phone: `091${String(Date.now()).slice(-7)}`, password };
      assert.equal((await pending.call("/auth/register", "POST", { ...registration, role: "admin", creditLimit: 999999 })).response.status, 400);
      const result = await pending.call("/auth/register", "POST", registration); assert.equal(result.response.status, 201);
      registeredId = result.data.user.id; customerId = result.data.user.customer.id;
      assert.equal(result.data.user.customer.creditLimit, 0); assert.equal(result.data.user.customer.status, "pending");
      assert.equal((await pending.call("/orders/quote", "POST", bodyQuote(body))).response.status, 403);
      assert.equal((await pending.call("/admin/state")).response.status, 403);
    });
    const command = async (actor: Actor, action: string, id: string | undefined, payload: object = {}, orderId = id) => {
      const state = (await actor.call("/admin/state")).data;
      const expectedRevision = state.orders.find((order: { id: string }) => order.id === orderId)?.revision;
      return actor.call("/admin/commands", "POST", { action, branch: "Quy Nhơn", id, payload, expectedRevision });
    };
    await t.test("One checkout order appears in Sales and warehouse transitions revalidate revision", async () => {
      const id = orderIds[0];
      const before = (await admin.call("/admin/state")).data.orders.find((item: { id: string }) => item.id === id);
      assert.equal(before.status, "Chờ xác nhận");
      assert.equal((await command(warehouse, "advance-order", id)).response.status, 403);
      assert.equal((await command(sales, "advance-order", id)).response.status, 201);
      assert.equal((await sales.call("/admin/commands", "POST", { action: "advance-order", id, branch: "Quy Nhơn", payload: {}, expectedRevision: before.revision })).response.status, 409);
      assert.equal((await command(warehouse, "advance-order", id)).response.status, 201);
      assert.equal((await command(warehouse, "advance-order", id)).response.status, 409);
      assert.equal((await command(warehouse, "pick-item", id, { productId, picked: true })).response.status, 201);
      assert.equal((await command(warehouse, "advance-order", id)).response.status, 201);
      assert.equal((await command(warehouse, "advance-order", id)).response.status, 201);
      assert.equal((await guest.call("/orders")).data.find((order: { id: string }) => order.id === id).status, "Đang giao");
      assert.equal((await command(sales, "advance-order", id)).response.status, 201);
      assert.equal((await guest.call("/orders")).data.find((order: { id: string }) => order.id === id).status, "Đã giao");
    });
    await t.test("B2B price approval remains pending until Sales confirms", async () => {
      const quote = (await b2b.call("/orders/quote", "POST", bodyQuote(body))).data;
      assert.ok(quote.total < product.price);
      const result = await b2b.call("/orders", "POST", body, { "Idempotency-Key": randomUUID() }); assert.equal(result.response.status, 201); orderIds.push(result.data.id);
      const requested = await command(sales, "create-approval", result.data.id, { type: "Giá đặc biệt", reason: "Integration test price", prices: { [productId]: 20000 } });
      assert.equal(requested.response.status, 201); approvalIds.push(requested.data.id);
      assert.equal((await command(sales, "decide-approval", requested.data.id, { approved: true, reason: "test" }, result.data.id)).response.status, 403);
      assert.equal((await command(admin, "decide-approval", requested.data.id, { approved: true, reason: "Integration test approved" }, result.data.id)).response.status, 201);
      const own = (await b2b.call("/orders")).data.find((order: { id: string }) => order.id === result.data.id);
      assert.equal(own.total, 20000); assert.equal(own.status, "Chờ xác nhận");
      assert.equal((await command(sales, "advance-order", result.data.id)).response.status, 201);
    });
    await t.test("Receipt amount/reference guards, reconciliation and preserved debt snapshot", async () => {
      const draft = { orderId: orderIds[0], amount: 10000, date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()), reference: `TEST-${randomUUID()}`, method: "Chuyển khoản", note: "Integration test" };
      const result = await command(accountant, "create-receipt", undefined, draft); assert.equal(result.response.status, 201); receiptIds.push(result.data.id);
      assert.equal((await command(accountant, "create-receipt", undefined, draft)).response.status, 409);
      assert.equal((await command(accountant, "reconcile-receipt", result.data.id, { amount: 9000, reference: draft.reference, note: "mismatch" })).response.status, 409);
      assert.equal((await command(accountant, "reconcile-receipt", result.data.id, { amount: 10000, reference: draft.reference, note: "checked" })).response.status, 201);
      assert.equal((await command(accountant, "void-receipt", result.data.id, { reason: "Integration test cleanup" })).response.status, 201);
      assert.equal((await b2b.call("/auth/session")).data.user.customer.debt, 12400000);
    });
    await t.test("Publication updates catalog; validated upload persists on backend", async () => {
      assert.equal((await command(admin, "publish-product", productId, { published: false })).response.status, 201);
      assert.ok(!(await guest.call("/catalog")).data.products.some((item: { id: string }) => item.id === productId));
      assert.equal((await command(admin, "publish-product", productId, { published: true })).response.status, 201);
      originalProduct = (await sql.query(`SELECT data FROM "${schema}".products WHERE id=$1`, [productId])).rows[0].data;
      const bad = new FormData(); bad.append("image", new Blob(["not-an-image"], { type: "image/png" }), "fake.png");
      assert.equal((await admin.call(`/media/products/${productId}/image`, "POST", bad)).response.status, 400);
      const form = new FormData(); form.append("image", new Blob([await sharp({ create: { width: 16, height: 16, channels: 3, background: "#1879d5" } }).png().toBuffer()], { type: "image/png" }), "../../unsafe.png");
      const result = await admin.call(`/media/products/${productId}/image`, "POST", form); assert.equal(result.response.status, 201);
      uploaded = result.data.url; assert.match(uploaded, /^\/media\/uploads\/[a-f0-9-]+\.webp$/);
      assert.equal((await fetch(`${base.replace("/api", "")}${uploaded}`)).status, 200);
      assert.equal((await guest.call("/catalog")).data.products.find((item: { id: string }) => item.id === productId).image, uploaded);
    });
    await t.test("Profile/preferences persist without accepting financial changes", async () => {
      originalProfile = (await sql.query(`SELECT profile FROM "${schema}".users WHERE email=$1`, ["kh001@baotin.local"])).rows[0].profile;
      assert.equal((await b2b.call("/account/preferences", "PATCH", { favorites: [productId], settings: [false, true, true], addresses: [{ id: "TEST-ADDRESS", name: "Test contact", phone: "0901000101", address: "Test address" }] })).response.status, 200);
      const profile = (await b2b.call("/account")).data;
      assert.deepEqual(profile.favorites, [productId]); assert.deepEqual(profile.settings, [false, true, true]); assert.equal(profile.addresses[0].id, "TEST-ADDRESS");
      assert.equal((await b2b.call("/account/preferences", "PATCH", { creditLimit: 999999999 })).response.status, 400);
    });
    await t.test("Contact requests and newsletter save to DB, not fake acknowledgements", async () => {
      const lead = await guest.call("/contact/consultations", "POST", { name: "Integration test", phone: "0901234567", email: "", message: "Please advise on test products" });
      assert.equal(lead.response.status, 201); leadId = lead.data.id;
      assert.ok((await admin.call("/contact/consultations")).data.some((item: { id: string }) => item.id === leadId));
      assert.equal((await b2b.call("/contact/consultations")).response.status, 403);
      newsletterEmail = `test-${randomUUID()}@example.com`;
      assert.equal((await guest.call("/contact/newsletter", "POST", { email: newsletterEmail })).response.status, 201);
      assert.equal((await guest.call("/contact/newsletter", "POST", { email: newsletterEmail })).response.status, 201);
      assert.equal(Number((await sql.query(`SELECT count(*) FROM "${schema}".newsletter_subscriptions WHERE email=$1`, [newsletterEmail])).rows[0].count), 1);
    });
    await t.test("Logout revokes the old JWT session", async () => {
      const token = b2b.cookies.get("baotin_session")!;
      assert.equal((await b2b.call("/auth/logout", "POST")).response.status, 201);
      b2b.cookies.set("baotin_session", token);
      assert.equal((await b2b.call("/account")).response.status, 401);
    });
  } finally {
    if (originalProduct) await sql.query(`UPDATE "${schema}".products SET data=$1,published=true WHERE id=$2`, [originalProduct, productId]);
    else await sql.query(`UPDATE "${schema}".products SET published=true WHERE id=$1`, [productId]);
    if (uploaded) await unlink(resolve("media", uploaded.replace("/media/", ""))).catch(() => {});
    if (originalProfile) await sql.query(`UPDATE "${schema}".users SET profile=$1 WHERE email=$2`, [originalProfile, "kh001@baotin.local"]);
    if (leadId) await sql.query(`DELETE FROM "${schema}".leads WHERE id=$1`, [leadId]);
    if (newsletterEmail) await sql.query(`DELETE FROM "${schema}".newsletter_subscriptions WHERE email=$1`, [newsletterEmail]);
    await sql.query(`DELETE FROM "${schema}".receipts WHERE id=ANY($1)`, [receiptIds]);
    await sql.query(`DELETE FROM "${schema}".approvals WHERE id=ANY($1)`, [approvalIds]);
    await sql.query(`DELETE FROM "${schema}".orders WHERE id=ANY($1)`, [orderIds]);
    await sql.query(`DELETE FROM "${schema}".audit_events WHERE "resourceId"=ANY($1)`, [[...receiptIds, ...approvalIds, ...orderIds]]);
    if (registeredId) { await sql.query(`DELETE FROM "${schema}".sessions WHERE "userId"=$1`, [registeredId]); await sql.query(`DELETE FROM "${schema}".users WHERE id=$1`, [registeredId]); await sql.query(`DELETE FROM "${schema}".customers WHERE id=$1`, [customerId]); }
    await sql.end();
  }
});
function bodyQuote(body: { items: unknown; delivery: string; coupon: string }) { return { items: body.items, delivery: body.delivery, coupon: body.coupon }; }
