import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { Client } from "pg";
import sharp from "sharp";

config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Product QA only targets local PostgreSQL.");
const base = "http://127.0.0.1:4004/api";

class Actor {
  cookie = "";
  async call(path: string, method = "GET", body?: object | FormData) {
    const headers = new Headers({ Origin: "http://localhost:3010", "X-BaoTin-Client": "web", Cookie: this.cookie });
    if (!(body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map(value => value.split(";")[0]).join("; ");
    return { status: response.status, data: await response.json() };
  }
}

test("Product management with isolated database and media", { timeout: 120000 }, async t => {
  const schema = `products_qa_${randomBytes(6).toString("hex")}`;
  const password = `Test-${randomBytes(16).toString("hex")}`;
  const media = await mkdtemp(join(tmpdir(), "baotin-product-media-"));
  const sql = new Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
  const child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, ENV_FILE: ".env.local", PORT: "4004", HOST: "127.0.0.1", DB_SCHEMA: schema, DB_SYNCHRONIZE: "true", DB_SSL: "false", NODE_ENV: "development", COOKIE_SECURE: "false", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, FRONTEND_ORIGINS: "http://localhost:3010", MEDIA_DIR: media, SMTP_URL: "", KIOTVIET_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  const admin = new Actor(), sales = new Actor(), warehouse = new Actor(), accountant = new Actor(), b2b = new Actor(), guest = new Actor();
  let id = "", revision = 0;
  let gallery: string[] = [];
  const draft = { name: "QA LED product", code: `QA-${randomUUID()}`, slug: `qa-${randomUUID()}`, category: "led-tu-ke", subcategory: "LED dây", brand: "Bảo Tín", unit: "cái", price: 0, specification: "", material: "", color: "", size: "", origin: "", description: "", gallery: [] as string[], featured: false, published: false };
  const patch = (changes: object) => admin.call(`/admin/products/${id}`, "PATCH", { ...draft, gallery, revision, ...changes });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`API failed: ${logs}`);
      if (await fetch(`${base}/health`).then(response => response.ok).catch(() => false)) break;
      if (attempt === 119) throw new Error(`Startup timeout: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const [actor, identity] of [[admin, "admin"], [sales, "sales"], [warehouse, "warehouse"], [accountant, "accountant"], [b2b, "kh001"]] as const) {
      assert.equal((await actor.call("/auth/login", "POST", { identity: `${identity}@baotin.local`, password })).status, 201);
    }
    await t.test("Only product managers can create, edit or upload", async () => {
      assert.equal((await guest.call("/admin/products", "POST", draft)).status, 401);
      for (const actor of [warehouse, accountant, b2b]) {
        assert.equal((await actor.call("/admin/products", "POST", draft)).status, 403);
        const data = new FormData(); data.append("images", new Blob(["fake"], { type: "image/png" }), "fake.png");
        assert.equal((await actor.call("/media/product-images", "POST", data)).status, 403);
      }
    });
    await t.test("Create a private product and hide it from guests and B2B", async () => {
      const result = await sales.call("/admin/products", "POST", draft);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      id = result.data.id; revision = result.data.product.revision;
      assert.equal(result.data.product.stock, 0);
      for (const actor of [guest, b2b]) {
        assert.ok(!(await actor.call("/catalog")).data.products.some((product: { id: string }) => product.id === id));
        assert.equal((await actor.call(`/catalog/${draft.slug}`)).status, 404);
        assert.equal((await actor.call(`/catalog/${id}`)).status, 404);
        assert.equal((await actor.call("/orders/quote", "POST", { items: [{ productId: id, quantity: 1 }], delivery: "Nhận tại cửa hàng", coupon: "" })).status, 409);
      }
      const state = (await admin.call("/admin/state")).data;
      assert.equal(state.products.find((product: { id: string }) => product.id === id).published, false);
      assert.equal(state.categories.length, 8);
      for (const actor of [warehouse, accountant, b2b]) assert.equal((await actor.call(`/admin/products/${id}`, "PATCH", { ...draft, revision })).status, 403);
    });
    await t.test("Reject duplicate identifiers and incomplete publication", async () => {
      assert.equal((await admin.call("/admin/products", "POST", { ...draft, slug: `${draft.slug}-other`, code: draft.code.toLowerCase() })).status, 409);
      assert.equal((await admin.call("/admin/products", "POST", { ...draft, code: `${draft.code}-other` })).status, 409);
      assert.equal((await patch({ published: true })).status, 400);
      assert.equal((await admin.call("/admin/commands", "POST", { action: "publish-product", id, branch: "Quy Nhơn", payload: { published: true } })).status, 400);
    });
    await t.test("Validate categories, identifiers, fields and image paths", async () => {
      for (const changes of [{ category: "missing" }, { subcategory: "Invalid group" }, { name: "  " }, { slug: "invalid/slug" }, { price: -1 }, { price: 1.5 }, { price: 100, oldPrice: 1 }, { stock: 999 }, { customerPrice: 1 }, { gallery: ["https://example.com/image.jpg"] }, { gallery: ["/media/uploads/../secret.png"] }, { gallery: ["/media/uploads/missing.webp"] }]) {
        assert.equal((await patch(changes)).status, 400, JSON.stringify(changes));
      }
    });
    await t.test("Malformed batches never write partial image files", async () => {
      const good = await sharp({ create: { width: 80, height: 60, channels: 3, background: "red" } }).png().toBuffer();
      const form = new FormData();
      form.append("images", new Blob([good], { type: "image/png" }), "good.png");
      form.append("images", new Blob(["not an image"], { type: "image/png" }), "bad.png");
      const before = await readdir(join(media, "uploads"));
      assert.equal((await admin.call("/media/product-images", "POST", form)).status, 400);
      assert.deepEqual(await readdir(join(media, "uploads")), before);
      const oversized = new FormData(); oversized.append("images", new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" }), "large.png");
      assert.equal((await admin.call("/media/product-images", "POST", oversized)).status, 413);
    });
    await t.test("Upload several real images to backend storage", async () => {
      const form = new FormData();
      for (const color of ["red", "green", "blue"]) {
        const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).png().toBuffer();
        form.append("images", new Blob([bytes], { type: "image/png" }), `${color}.png`);
      }
      const result = await admin.call("/media/product-images", "POST", form);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      gallery = result.data.urls;
      assert.equal(gallery.length, 3);
      for (const url of gallery) {
        const response = await fetch(`http://127.0.0.1:4004${url}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type")!, /image\/webp/);
      }
      const tooMany = new FormData();
      for (let i = 0; i < 11; i++) tooMany.append("images", new Blob(["fake"], { type: "image/png" }), `${i}.png`);
      assert.equal((await admin.call("/media/product-images", "POST", tooMany)).status, 400);
    });
    await t.test("Publish, reorder, choose cover, remove and persist descriptions", async () => {
      const result = await patch({ price: 125000, specification: "12V · 8W", published: true, description: "Saved description\nSecond line" });
      assert.equal(result.status, 200, JSON.stringify(result.data)); revision = result.data.product.revision;
      assert.equal((await guest.call(`/catalog/${draft.slug}`)).data.description, "Saved description\nSecond line");
      const reversed = [gallery[2], gallery[0]];
      const updated = await patch({ gallery: reversed, price: 125000, specification: "12V · 8W", published: true });
      assert.equal(updated.status, 200); revision = updated.data.product.revision;
      const publicProduct = (await guest.call(`/catalog/${draft.slug}`)).data;
      assert.equal(publicProduct.image, reversed[0]);
      assert.deepEqual(publicProduct.gallery, reversed);
      assert.equal((await patch({ gallery: [gallery[0], gallery[0]] })).status, 400);
    });
    await t.test("Stale edits are rejected without overwriting", async () => {
      const first = await patch({ name: "First editor" });
      assert.equal(first.status, 200);
      assert.equal((await patch({ name: "Second stale editor" })).status, 409);
      revision = first.data.product.revision;
      assert.equal((await admin.call(`/admin/products/${id}`, "PATCH", { ...draft })).status, 400);
    });
    await t.test("A cleared old price is removed instead of retaining the previous value", async () => {
      const withOld = await patch({ oldPrice: 150000 });
      assert.equal(withOld.status, 200); revision = withOld.data.product.revision;
      const cleared = await patch({});
      assert.equal(cleared.status, 200); revision = cleared.data.product.revision;
      assert.equal(cleared.data.product.oldPrice, undefined);
      const restored = await patch({ oldPrice: 150000 });
      assert.equal(restored.status, 200); revision = restored.data.product.revision;
      const clearedNull = await patch({ oldPrice: null });
      assert.equal(clearedNull.status, 200); revision = clearedNull.data.product.revision;
      assert.equal(clearedNull.data.product.oldPrice, undefined);
    });
    await t.test("Protect inventory and identities used in operations", async () => {
      await sql.query(`INSERT INTO "${schema}".inventory_balances (id,branch,"productId","onHand") VALUES ($1,$2,$3,9)`, [`Quy Nhơn:${id}`, "Quy Nhơn", id]);
      assert.equal((await patch({ code: `${draft.code}-changed` })).status, 409);
      assert.equal((await patch({ unit: "bộ" })).status, 409);
      const result = await patch({ name: "Updated product", price: 99999 });
      assert.equal(result.status, 200); revision = result.data.product.revision;
      assert.equal((await sql.query(`SELECT "onHand" FROM "${schema}".inventory_balances WHERE "productId"=$1`, [id])).rows[0].onHand, 9);
      const audit = (await sql.query(`SELECT action FROM "${schema}".audit_events WHERE "resourceId"=$1`, [id])).rows;
      assert.ok(audit.some(row => row.action === "product-create"));
      assert.ok(audit.some(row => row.action === "product-update"));
    });
    await t.test("List-price pricing is server-authored, private for B2B and consistent in search/checkout", async () => {
      const body = { ...draft, code: `${draft.code}-pricing`, slug: `${draft.slug}-pricing`, gallery, specification: "QA pricing", published: true, listPrice: 100000, b2cDiscount: 20, b2bDiscount: 35, price: 1 };
      const created = await admin.call("/admin/products", "POST", body);
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const pricedId = created.data.id;
      assert.equal(created.data.product.price, 80000); assert.equal(created.data.product.oldPrice, 100000); assert.equal(created.data.product.b2bDiscount, 35);
      await sql.query(`INSERT INTO "${schema}".inventory_balances (id,branch,"productId","onHand") VALUES ($1,$2,$3,10)`, [`Quy Nhơn:${pricedId}`, "Quy Nhơn", pricedId]);
      await sql.query(`DELETE FROM "${schema}".price_policies`);
      const guestProduct = (await guest.call(`/catalog/${body.slug}`)).data;
      assert.equal(guestProduct.price, 80000); assert.equal(guestProduct.listPrice, 100000); assert.equal(guestProduct.b2cDiscount, 20);
      assert.equal(guestProduct.b2bDiscount, undefined); assert.equal(guestProduct.customerPrice, undefined);
      const selection = `/catalog/selection?ids=${pricedId}`;
      assert.equal((await b2b.call(selection)).data.products[0].customerPrice, 65000);
      assert.equal((await guest.call(selection)).data.products[0].b2bDiscount, undefined);
      const quote = { items: [{ productId: pricedId, quantity: 1 }], delivery: "Nhận tại cửa hàng", coupon: "" };
      assert.equal((await guest.call("/orders/quote", "POST", quote)).data.items[0].unitPrice, 80000);
      assert.equal((await b2b.call("/orders/quote", "POST", quote)).data.items[0].unitPrice, 65000);
      const search = `/catalog/search?${new URLSearchParams({ q: body.code, max: "66000", sort: "low" })}`;
      assert.equal((await b2b.call(search)).data.products[0].customerPrice, 65000);
      assert.equal((await guest.call(search)).data.total, 0);
      const state = (await admin.call("/admin/state")).data;
      const customer = state.customers.find((row: { id: string }) => row.id === "KH001");
      const groupPolicy = await admin.call("/admin/pricing", "POST", { branch: "Quy Nhơn", name: "QA list-price group", scope: "group", target: customer.group, discount: 10, prices: {}, startsOn: "2000-01-01", endsOn: null, active: true });
      assert.equal(groupPolicy.status, 201, JSON.stringify(groupPolicy.data));
      assert.equal((await b2b.call(selection)).data.products[0].customerPrice, 90000);
      assert.equal((await b2b.call("/orders/quote", "POST", quote)).data.items[0].unitPrice, 90000);
      assert.equal((await b2b.call(search)).data.total, 0);
      const specific = await admin.call("/admin/pricing", "POST", { branch: "Quy Nhơn", name: "QA SKU override", scope: "customer", target: "KH001", discount: 0, prices: { [pricedId]: 55000 }, startsOn: "2000-01-01", endsOn: null, active: true });
      assert.equal(specific.status, 201);
      assert.equal((await b2b.call("/orders/quote", "POST", quote)).data.items[0].unitPrice, 55000);
      assert.equal((await guest.call("/orders/quote", "POST", quote)).data.items[0].unitPrice, 80000);
      const warehouseProduct = (await warehouse.call("/admin/resources?branch=Quy+Nh%C6%A1n&include=products")).data.products.find((row: { id: string }) => row.id === pricedId);
      for (const key of ["listPrice", "b2cDiscount", "b2bDiscount", "customerPrice", "oldPrice"]) assert.equal(warehouseProduct[key], undefined);
      for (const change of [{ b2cDiscount: 100 }, { b2bDiscount: -1 }, { b2cDiscount: 0.001 }, { listPrice: 1.5 }, { b2bPrice: 1 }]) assert.equal((await admin.call(`/admin/products/${pricedId}`, "PATCH", { ...body, revision: created.data.product.revision, ...change })).status, 400, JSON.stringify(change));
      const { b2bDiscount: _b2b, ...partial } = body;
      assert.equal((await admin.call(`/admin/products/${pricedId}`, "PATCH", { ...partial, revision: created.data.product.revision })).status, 400);
      const saved = await admin.call(`/admin/products/${pricedId}`, "PATCH", { ...body, revision: created.data.product.revision, b2cDiscount: 12.34 });
      assert.equal(saved.status, 200); assert.equal(saved.data.product.price, 87660);
      assert.equal((await admin.call(`/admin/products/${pricedId}`, "PATCH", { ...body, revision: created.data.product.revision })).status, 409);
    });
    await t.test("Flexible variants keep independent SKU prices, inventory and public visibility", async () => {
      const shared = { ...draft, name: "QA configurable shelf", specification: "Inox 304", gallery, published: true, listPrice: 100000, b2cDiscount: 10, b2bDiscount: 20, price: 1 };
      const rootBody = { ...shared, code: `${draft.code}-600`, slug: `${draft.slug}-600`, size: "600mm", color: "Bạc", variantGroupId: "self", variantAttributes: [{ name: "Kích thước", value: "600mm" }, { name: "Màu sắc", value: "Bạc" }] };
      const root = await admin.call("/admin/products", "POST", rootBody);
      assert.equal(root.status, 201, JSON.stringify(root.data));
      const rootId = root.data.id;
      assert.equal(root.data.product.variantGroupId, rootId);
      const childBody = { ...shared, code: `${draft.code}-800`, slug: `${draft.slug}-800`, size: "", color: "", listPrice: 200000, variantGroupId: rootId, variantAttributes: [{ name: "Kích thước", value: "800mm" }, { name: "Màu sắc", value: "Bạc" }] };
      const child = await admin.call("/admin/products", "POST", childBody);
      assert.equal(child.status, 201, JSON.stringify(child.data));
      assert.equal(child.data.product.price, 180000);
      assert.equal(child.data.product.size, "800mm"); assert.equal(child.data.product.color, "Bạc");
      await sql.query(`DELETE FROM "${schema}".price_policies`);
      await sql.query(`INSERT INTO "${schema}".inventory_balances (id,branch,"productId","onHand") VALUES ($1,$2,$3,7)`, [`Quy Nhơn:${child.data.id}`, "Quy Nhơn", child.data.id]);
      const detail = (await guest.call(`/catalog/product/${childBody.slug}`)).data;
      assert.equal(detail.variants.length, 2);
      assert.equal(detail.variants.find((item: { id: string }) => item.id === child.data.id).stock, 7);
      assert.ok(detail.variants.every((item: Record<string, unknown>) => item.b2bDiscount === undefined && item.customerPrice === undefined));
      assert.equal((await b2b.call(`/catalog/selection?ids=${child.data.id}`)).data.products[0].customerPrice, 160000);
      assert.equal((await guest.call("/orders/quote", "POST", { items: [{ productId: child.data.id, quantity: 1 }], delivery: "Nhận tại cửa hàng", coupon: "" })).data.items[0].unitPrice, 180000);
      const search = (await guest.call(`/catalog/search?${new URLSearchParams({ q: shared.name, category: shared.category })}`)).data;
      assert.equal(search.products.filter((item: { variantGroupId?: string }) => item.variantGroupId === rootId).length, 1);
      assert.equal(search.products.find((item: { variantGroupId?: string }) => item.variantGroupId === rootId)?.id, rootId);
      assert.equal((await guest.call("/catalog/bootstrap")).data.products.filter((item: { variantGroupId?: string }) => item.variantGroupId === rootId).length <= 1, true);
      const duplicate = await admin.call("/admin/products", "POST", { ...childBody, code: `${draft.code}-dup`, slug: `${draft.slug}-dup`, variantAttributes: [{ name: "kích thước", value: "800MM" }, { name: "Màu sắc", value: "BẠC" }] });
      assert.equal(duplicate.status, 409);
      const wrongOrder = await admin.call("/admin/products", "POST", { ...childBody, code: `${draft.code}-wrong`, slug: `${draft.slug}-wrong`, variantAttributes: [...childBody.variantAttributes].reverse() });
      assert.equal(wrongOrder.status, 400);
      const privateChild = await admin.call("/admin/products", "POST", { ...childBody, code: `${draft.code}-900`, slug: `${draft.slug}-900`, published: false, variantAttributes: [{ name: "Kích thước", value: "900mm" }, { name: "Màu sắc", value: "Bạc" }] });
      assert.equal(privateChild.status, 201);
      assert.equal((await guest.call(`/catalog/product/${childBody.slug}`)).data.variants.length, 2);
      assert.equal((await guest.call(`/catalog/product/${privateChild.data.id}`)).status, 404);
      const rootEdit = await admin.call(`/admin/products/${rootId}`, "PATCH", { ...rootBody, variantGroupId: rootId, revision: root.data.product.revision, variantAttributes: [{ name: "Chiều dài", value: "600mm" }, { name: "Màu sắc", value: "Bạc" }] });
      assert.equal(rootEdit.status, 400);
    });
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.end();
    await rm(media, { recursive: true, force: true });
  }
});
