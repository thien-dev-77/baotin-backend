import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import type { Product, OrderLine } from "../src/types/domain.types";

config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1") throw new Error("Catalog QA only targets local PostgreSQL.");
const base = "http://127.0.0.1:4009/api";
class Actor {
  cookies = new Map<string, string>();
  async call(path: string, method = "GET", body?: object, key?: string) {
    const response = await fetch(base + path, { method, headers: { Origin: "http://localhost:3010", "X-BaoTin-Client": "web", Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "), "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const cookie of response.headers.getSetCookie()) { const [name, ...value] = cookie.split(";")[0].split("="); this.cookies.set(name, value.join("=")); }
    return { status: response.status, data: response.headers.get("content-type")?.includes("application/pdf") ? Buffer.from(await response.arrayBuffer()) : await response.json() };
  }
}

test("Paginated catalog and historical order snapshots", { timeout: 120000 }, async t => {
  const schema = `catalog_qa_${randomBytes(6).toString("hex")}`;
  const password = `QA-${randomBytes(20).toString("hex")}`;
  const sql = new Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
  const child = spawn(process.execPath, ["dist/main.js"], { env: { ...process.env, ENV_FILE: ".env.local", DB_SCHEMA: schema, PORT: "4009", HOST: "127.0.0.1", DB_SYNCHRONIZE: "true", DB_SSL: "false", NODE_ENV: "development", COOKIE_SECURE: "false", SEED_MOCK_DATA: "true", SEED_PASSWORD: password, FRONTEND_ORIGINS: "http://localhost:3010", KIOTVIET_ENABLED: "false", SMTP_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  const guest = new Actor(), admin = new Actor(), b2b = new Actor(), otherBranch = new Actor(), outsider = new Actor();
  const fixtures: Product[] = [];
  let orderId = "", savedSnapshot: OrderLine["snapshot"];
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(logs);
      if (await fetch(base + "/health").then(response => response.ok).catch(() => false)) break;
      if (attempt === 149) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const [actor, identity] of [[admin, "admin"], [b2b, "kh001"], [otherBranch, "kh005"]] as const) assert.equal((await actor.call("/auth/login", "POST", { identity: `${identity}@baotin.local`, password })).status, 201);
    const template = (await guest.call("/catalog")).data.products[0] as Product;
    for (let index = 0; index < 65; index++) {
      const product: Product = { ...template, id: `QA-PAGE-${String(index).padStart(3, "0")}`, slug: `qa-page-${index}`, code: `QA-CODE-${index}`, name: `Đèn QA Catalog ${index}`, category: "led-tu-ke", subcategory: "LED dây", brand: index % 2 ? "QA Brand B" : "QA Brand A", material: index % 2 ? "Thép" : "Nhôm", color: "Bạc", size: "100 mm", origin: "Việt Nam", price: (index + 1) * 1000, stock: 5, featured: index % 3 === 0 };
      fixtures.push(product);
      await sql.query(`INSERT INTO "${schema}".products (id, slug, data, published, "createdAt", revision) VALUES ($1,$2,$3,true,$4,1)`, [product.id, product.slug, product, new Date(Date.UTC(2026, 9, 8, 0, index))]);
    }
    await sql.query(`INSERT INTO "${schema}".products (id,slug,data,published,revision) VALUES ($1,$2,$3,false,1)`, ["QA-PRIVATE", "qa-private", { ...fixtures[0], id: "QA-PRIVATE", slug: "qa-private", brand: "QA Hidden Brand" }]);
    await t.test("Page size, stable sort, out-of-range page and accented search", async () => {
      const first = await guest.call("/catalog/search?q=den%20qa%20catalog&pageSize=12&sort=low");
      assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.total, 65); assert.equal(first.data.products.length, 12); assert.equal(first.data.totalPages, 6);
      assert.equal(first.data.products[0].id, fixtures[0].id);
      const second = (await guest.call("/catalog/search?q=Đèn%20QA%20Catalog&page=2&pageSize=12&sort=low")).data;
      assert.equal(second.products[0].id, fixtures[12].id);
      const last = (await guest.call("/catalog/search?q=qa%20catalog&page=999&sort=low")).data;
      assert.equal(last.page, 6); assert.equal(last.products.length, 5);
      assert.equal((await guest.call("/catalog/search?q=qa%20catalog&sort=new")).data.products[0].id, fixtures[64].id);
      assert.equal((await guest.call("/catalog/search?q=%25")).data.total, 0);
      assert.ok(!first.data.brands.includes("QA Hidden Brand"));
      assert.ok(first.data.products.every((product: Product) => product.customerPrice === undefined));
    });
    await t.test("Filters and strict pagination validation", async () => {
      const result = (await guest.call("/catalog/search?q=qa%20catalog&brand=QA%20Brand%20A&material=Nhôm&min=10000&max=20000&sort=high")).data;
      assert.equal(result.total, 5); assert.equal(result.products[0].price, 19000);
      for (const query of ["page=0", "pageSize=61", "pageSize=1.5", "sort=sql", "min=-1", "min=2&max=1", "unknown=x", "stock=bad"]) assert.equal((await guest.call("/catalog/search?" + query)).status, 400, query);
      assert.equal((await guest.call("/catalog/selection?ids=QA-PRIVATE")).data.products.length, 0);
      assert.equal((await guest.call("/catalog/selection")).data.products.length, 0);
      const selection = (await guest.call("/catalog/selection?ids=" + fixtures[64].id)).data;
      assert.equal(selection.products[0].id, fixtures[64].id);
      assert.equal((await guest.call("/catalog/selection?code=qa-code-64")).data.products[0].id, fixtures[64].id);
      const bootstrap = (await guest.call("/catalog/bootstrap")).data;
      assert.ok(bootstrap.products.length <= 55); assert.ok(bootstrap.brands.includes("QA Brand B"));
    });
    await t.test("Material groups match synonyms and compounds without changing exact legacy filters", async () => {
      const materials = ["SUS304", "SUS 304", "Inox 304 xước mờ", "Inox SUS304 và nhựa ABS", "Khung thép sơn tĩnh điện + inox 304", "Khung làm bằng nhôm, ray bằng thép", "Khung sườn bằng nhôm, ray bằng thép không gỉ", "Thép", "Polyamid", "Cửa kính toàn phần, 3 lớp cách nhiệt", "Mặt gốm thủy tinh SCHOTT Ceran", "Thân Zamak", "Đồng mạ crôm và đá granite", "Silicone", "Vật liệu chưa công bố", "Gỗ QA riêng tư"];
      const ids = materials.map((_, index) => `QA-MATERIAL-${index}`);
      try {
        for (const [index, material] of materials.entries()) {
          const product = { ...template, id: ids[index], slug: `qa-material-${index}`, code: ids[index], name: `QA material groups ${index}`, category: "led-tu-ke", subcategory: "LED dây", brand: "QA Material Brand", material, price: 100000 + index * 1000, stock: 5, featured: false };
          await sql.query(`INSERT INTO "${schema}".products (id,slug,data,published,revision) VALUES ($1,$2,$3,$4,1)`, [product.id, product.slug, product, index !== 15]);
        }
        const search = (query: string) => guest.call("/catalog/search?q=qa%20material%20groups&pageSize=60&" + query);
        for (const [query, indices] of [
          ["materialGroup=inox-304", [0, 1, 2, 3, 4]],
          ["materialGroup=plastic", [3, 8]],
          ["materialGroup=steel", [4, 5, 7]],
          ["materialGroup=inox-other", [6]],
          ["materialGroup=inox-304&materialGroup=steel", [0, 1, 2, 3, 4, 5, 7]],
          ["materialGroup=glass", [9, 10]],
          ["materialGroup=other", [14]],
          ["materialGroup=wood", []],
          ["material=SUS304", [0]],
          ["materialGroup=inox-304&material=SUS304", [0]],
        ] as const) {
          const result = await search(query);
          assert.equal(result.status, 200, JSON.stringify(result.data));
          assert.equal(result.data.total, indices.length, query);
          assert.deepEqual(new Set(result.data.products.map((row: Product) => row.id)), new Set(indices.map(index => ids[index])), query);
        }
        const page = await guest.call("/catalog/search?q=qa%20material%20groups&brand=QA%20Material%20Brand&category=led-tu-ke&materialGroup=inox-304&sort=low&pageSize=2&page=2");
        assert.equal(page.data.total, 5); assert.equal(page.data.totalPages, 3);
        assert.deepEqual(page.data.products.map((row: Product) => row.id), [ids[2], ids[3]]);
        const exact = await search("material=SUS304");
        assert.equal(exact.data.products[0].material, "SUS304");
        assert.ok(exact.data.facets.material.includes("SUS304"));
        assert.ok(!exact.data.facets.material.includes("Gỗ QA riêng tư"));
        assert.equal((await search("materialGroup=not-a-group")).status, 400);
        assert.equal((await search(Array.from({ length: 32 }, () => "materialGroup=steel").join("&"))).status, 400);
      } finally { await sql.query(`DELETE FROM "${schema}".products WHERE id = ANY($1::text[])`, [ids]); }
    });
    await t.test("Manual facets override descriptions, combine with scope, and publish only effective options", async () => {
      const baseline = (await guest.call("/catalog/search")).data.facets;
      const products = [
        { material: "Inox 304", color: "Đen mờ", origin: "Germany" },
        { material: "Inox 304", materialGroups: ["plastic"], color: "Đen mờ", colorGroups: ["white"], origin: "Germany", originGroups: ["malaysia"] },
        { material: "Inox 304", materialGroups: [], color: "Đen", colorGroups: [], origin: "Germany", originGroups: [] },
        { material: "SUS304", materialGroups: null, color: "White", colorGroups: null, origin: "Made in Malaysia", originGroups: null },
        { material: "Nhựa", materialGroups: ["plastic"], color: "Đen", colorGroups: ["gold"], origin: "Germany", originGroups: ["italy"] },
      ];
      const ids = products.map((_, index) => `QA-FACET-${index}`);
      try {
        for (const [index, fields] of products.entries()) {
          const product = { ...template, ...fields, id: ids[index], slug: `qa-facet-${index}`, code: ids[index], name: `QA explicit facets ${index}`, brand: "QA Facets", category: "led-tu-ke", subcategory: "LED dây", price: 100000, featured: false };
          await sql.query(`INSERT INTO "${schema}".products (id,slug,data,published,revision) VALUES ($1,$2,$3,$4,1)`, [product.id, product.slug, product, index !== 4]);
        }
        for (const [query, expected] of [
          ["materialGroup=inox-304", [0, 3]], ["materialGroup=plastic", [1]],
          ["colorGroup=black", [0]], ["colorGroup=white", [1, 3]],
          ["colorGroup=white&colorGroup=black", [0, 1, 3]], ["originGroup=germany", [0]],
          ["originGroup=malaysia", [1, 3]], ["colorGroup=white&originGroup=malaysia&materialGroup=plastic", [1]],
          ["color=Đen mờ", [0, 1]], ["origin=Germany", [0, 1, 2]],
        ] as const) {
          const response = await guest.call("/catalog/search?brand=QA%20Facets&pageSize=60&" + query);
          assert.equal(response.status, 200, JSON.stringify(response.data));
          assert.deepEqual(new Set(response.data.products.map((product: Product) => product.id)), new Set(expected.map(index => ids[index])), query);
        }
        const response = await guest.call("/catalog/search?brand=QA%20Facets&colorGroup=white&originGroup=malaysia&category=led-tu-ke&pageSize=1&page=2");
        assert.equal(response.data.total, 2); assert.equal(response.data.page, 2);
        assert.deepEqual(new Set(response.data.facets.colorGroup), new Set([...baseline.colorGroup, "black", "white"]), "private overrides must not leak into facets");
        assert.deepEqual(new Set(response.data.facets.originGroup), new Set([...baseline.originGroup, "germany", "malaysia"]));
        assert.ok(response.data.facets.colorGroup.includes("white"));
        assert.equal(response.data.products[0].color, "White", "grouping must preserve detailed text");
        for (const query of ["colorGroup=bad", "originGroup=bad", "colorGroup=" + "x".repeat(100), ...["colorGroup", "originGroup"].map(key => Array.from({ length: 32 }, () => `${key}=other`).join("&"))]) {
          assert.equal((await guest.call("/catalog/search?" + query)).status, 400);
        }
      } finally { await sql.query(`DELETE FROM "${schema}".products WHERE id = ANY($1::text[])`, [ids]); }
    });
    await t.test("Cards receive published review aggregates without pending/rejected reviews", async () => {
      for (const [stars, status] of [[5, "published"], [3, "published"], [1, "pending"], [1, "rejected"]] as const) {
        await sql.query(`INSERT INTO "${schema}".product_reviews (id,"productId","userId",name,stars,text,status,revision) VALUES ($1,$2,$3,$4,$5,$6,$7,1)`, [randomUUID(), fixtures[0].id, randomUUID(), "QA Reviewer", stars, "QA review text", status]);
      }
      const selection = await guest.call(`/catalog/selection?ids=${fixtures[0].id}&ids=${fixtures[1].id}`);
      assert.deepEqual(selection.data.products.find((product: Product) => product.id === fixtures[0].id).reviewSummary, { rating: 4, count: 2 });
      assert.deepEqual(selection.data.products.find((product: Product) => product.id === fixtures[1].id).reviewSummary, { rating: 0, count: 0 });
      const search = await guest.call("/catalog/search?q=qa%20catalog&sort=low");
      assert.deepEqual(search.data.products[0].reviewSummary, { rating: 4, count: 2 });
      assert.equal((await guest.call("/catalog/selection?ids=QA-PRIVATE")).data.products.length, 0);
    });
    await t.test("Homepage picks five distinct variant groups from managed categories, excluding hidden/private rows", async () => {
      const categories = ["qa-home-visible", "qa-home-hidden"];
      for (const slug of categories) {
        await sql.query(`INSERT INTO "${schema}".categories (slug,data,revision) VALUES ($1,$2,1)`, [slug, { slug, name: slug, image: "", description: "", subcategories: ["QA subcategory"], visible: slug === categories[0], sortOrder: -10 }]);
      }
      for (let index = 0; index < 12; index++) {
        const id = `QA-HOME-${String(index).padStart(2, "0")}`;
        const data = { ...fixtures[0], id, code: id, slug: id.toLowerCase(), category: categories[0], subcategory: "QA subcategory", variantGroupId: index < 6 ? "QA-HOME-00" : undefined, variantAttributes: index < 6 ? [{ name: "Kích thước", value: `${index}mm` }] : undefined };
        await sql.query(`INSERT INTO "${schema}".products (id,slug,data,published,revision) VALUES ($1,$2,$3,$4,1)`, [id, data.slug, data, index !== 11]);
      }
      const hidden = { ...fixtures[0], id: "QA-HOME-HIDDEN", slug: "qa-home-hidden", category: categories[1] };
      await sql.query(`INSERT INTO "${schema}".products (id,slug,data,published,revision) VALUES ($1,$2,$3,true,1)`, [hidden.id, hidden.slug, hidden]);
      const response = await guest.call("/catalog/bootstrap");
      assert.equal(response.status, 200, JSON.stringify(response.data));
      const cards: Product[] = response.data.products.filter((product: Product) => product.category === categories[0]);
      assert.equal(cards.length, 5);
      assert.equal(new Set(cards.map(product => product.variantGroupId || product.id)).size, 5);
      assert.ok(cards.some(product => product.id === "QA-HOME-00"));
      assert.ok(!response.data.products.some((product: Product) => product.id === "QA-HOME-11"));
      assert.ok(!response.data.categories.some((category: { slug: string }) => category.slug === categories[1]));
      assert.ok(response.data.products.length <= 55);
      await sql.query(`DELETE FROM "${schema}".products WHERE data->>'category' = ANY($1::text[])`, [categories]);
      await sql.query(`DELETE FROM "${schema}".categories WHERE slug = ANY($1::text[])`, [categories]);
    });
    await t.test("B2B price filtering/sorting uses the same customer policy as checkout", async () => {
      const customer = (await admin.call("/admin/state")).data.customers.find((row: { id: string }) => row.id === "KH001");
      const policy = { name: "QA customer prices", scope: "customer", target: "KH001", branch: "Quy Nhơn", startsOn: "2000-01-01", endsOn: null, active: true, discount: 0, prices: { [fixtures[64].id]: 1 } };
      await sql.query(`INSERT INTO "${schema}".price_policies (id,branch,data,revision) VALUES ($1,$2,$3,1)`, [randomUUID(), customer.branch, policy]);
      const result = (await b2b.call("/catalog/search?q=qa%20catalog&sort=low&max=10")).data;
      assert.equal(result.total, 1); assert.equal(result.products[0].id, fixtures[64].id); assert.equal(result.products[0].customerPrice, 1);
      const quote = (await b2b.call("/orders/quote", "POST", { items: [{ productId: fixtures[64].id, quantity: 1 }], delivery: "Nhận tại cửa hàng", coupon: "" })).data;
      assert.equal(quote.items[0].unitPrice, 1);
      assert.equal((await guest.call("/catalog/search?q=qa%20catalog&max=10")).data.total, 0);
      assert.equal((await otherBranch.call("/catalog/search?q=qa%20catalog&stock=in")).data.total, 0);
    });
    await t.test("Stock filters subtract active reservations rather than raw stock", async () => {
      const row = { id: "QA-RESERVATION", customerId: null, customerName: "QA", branch: "Quy Nhơn", date: "2026-10-08", channel: "B2C", source: "QA", status: "Chờ soạn hàng", items: [{ productId: fixtures[1].id, quantity: 5, unitPrice: 2000 }], total: 10000, credit: false };
      await sql.query(`INSERT INTO "${schema}".orders (id,branch,data,revision) VALUES ($1,$2,$3,1)`, [row.id, row.branch, row]);
      const result = (await guest.call("/catalog/search?q=qa%20catalog&stock=out")).data;
      assert.equal(result.total, 1); assert.equal(result.products[0].id, fixtures[1].id); assert.equal(result.products[0].stock, 0);
    });
    const checkout = { items: [{ productId: fixtures[0].id, quantity: 2 }], customer: { name: "QA Guest", phone: "0901234567", email: "", address: "", city: "", district: "", ward: "" }, delivery: "Nhận tại cửa hàng", payment: "Chuyển khoản ngân hàng", note: "", coupon: "" };
    const key = randomUUID();
    await t.test("Snapshots are server-authored and persisted atomically with checkout", async () => {
      assert.equal((await guest.call("/orders", "POST", { ...checkout, items: [{ ...checkout.items[0], snapshot: { name: "Forged" } }] }, randomUUID())).status, 400);
      const result = await guest.call("/orders", "POST", checkout, key);
      assert.equal(result.status, 201, JSON.stringify(result.data));
      orderId = result.data.id; savedSnapshot = result.data.items[0].snapshot;
      assert.deepEqual(savedSnapshot, { name: fixtures[0].name, code: fixtures[0].code, image: fixtures[0].image, slug: fixtures[0].slug, unit: fixtures[0].unit });
      assert.equal(result.data.items[0].unitPrice, 1000);
    });
    await t.test("Rename/hide and idempotent retry do not rewrite the historical snapshot", async () => {
      await sql.query(`UPDATE "${schema}".products SET data=jsonb_set(data,'{name}','"Renamed after purchase"'),published=false WHERE id=$1`, [fixtures[0].id]);
      const order = (await guest.call("/orders")).data.find((row: { id: string }) => row.id === orderId);
      assert.deepEqual(order.items[0].snapshot, savedSnapshot); assert.equal(order.items[0].unitPrice, 1000);
      const retry = await guest.call("/orders", "POST", checkout, key);
      assert.equal(retry.data.id, orderId); assert.deepEqual(retry.data.items[0].snapshot, savedSnapshot);
      assert.equal((await outsider.call("/orders")).data.length, 0);
      const pdf = await guest.call(`/orders/${orderId}/document`);
      assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    });
    await t.test("Sales edits preserve existing snapshots and capture only newly added lines", async () => {
      await sql.query(`UPDATE "${schema}".products SET published=true WHERE id=$1`, [fixtures[0].id]);
      const state = (await admin.call("/admin/state")).data;
      const order = state.orders.find((row: { id: string }) => row.id === orderId);
      const items = [{ productId: fixtures[0].id, quantity: 1 }, { productId: fixtures[2].id, quantity: 1 }];
      const quote = (await admin.call("/admin/orders/quote", "POST", { id: orderId, branch: "Quy Nhơn", customerId: "", source: order.source, items, details: order.details })).data;
      const result = await admin.call("/admin/commands", "POST", { action: "save-order", id: orderId, branch: "Quy Nhơn", expectedRevision: order.revision, payload: { customerId: "", source: order.source, items, details: order.details, reason: "QA edit", expectedTotal: quote.total } });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      const saved = (await guest.call("/orders")).data.find((row: { id: string }) => row.id === orderId);
      assert.deepEqual(saved.items[0].snapshot, savedSnapshot); assert.equal(saved.items[1].snapshot.name, fixtures[2].name);
    });
    await t.test("Legacy lines remain readable without invented historical labels", async () => {
      await sql.query(`UPDATE "${schema}".orders SET data=jsonb_set(data,'{items}',(SELECT jsonb_agg(value-'snapshot') FROM jsonb_array_elements(data->'items'))) WHERE id=$1`, [orderId]);
      const saved = (await guest.call("/orders")).data.find((row: { id: string }) => row.id === orderId);
      assert.equal(saved.items[0].snapshot, undefined); assert.equal(saved.items.length, 2);
    });
    await t.test("Product detail slugs cannot collide with search/bootstrap/selection routes", async () => {
      for (const slug of ["search", "bootstrap", "selection"]) {
        await sql.query(`UPDATE "${schema}".products SET slug=$1::text,data=jsonb_set(data,'{slug}',to_jsonb($1::text)) WHERE id=$2`, [slug, fixtures[64].id]);
        const result = await guest.call(`/catalog/product/${slug}`);
        assert.equal(result.status, 200);
        assert.equal(result.data.id, fixtures[64].id);
      }
      assert.equal((await guest.call("/catalog/product/qa-private")).status, 404);
    });
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.end();
  }
});
