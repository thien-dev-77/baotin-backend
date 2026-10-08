import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import { DataSource } from "typeorm";
import { DatabaseService } from "../dist/database/database.service";
import { entities, OrderEntity, ProductEntity, UserEntity } from "../dist/database/entities";
import { KiotClient } from "../dist/integrations/kiot-client";
import { KiotService } from "../dist/integrations/kiot.service";
import { LedgerService, reservedQuantity } from "../dist/ledger/ledger.service";
import { CustomerEntity } from "../dist/database/entities";
import {
  CreditEntity,
  InventoryEntity,
  LedgerEntity,
} from "../dist/database/operations.entities";
import type { AdminOrder } from "../src/types/domain.types";

config({ path: ".env.local", quiet: true });
if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw new Error("Operations tests only target local PostgreSQL.");
const base = "http://127.0.0.1:4003/api";
const password = `Test-${randomBytes(16).toString("hex")}`;
class Actor {
  cookie = "";
  cookies = new Map<string, string>();
  async call(path: string, method = "GET", body?: object) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: "http://localhost:3010",
        "X-BaoTin-Client": "web",
        Cookie: this.cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0];
      this.cookies.set(pair.split("=")[0], pair);
    }
    if (response.headers.getSetCookie().length)
      this.cookie = [...this.cookies.values()].join("; ");
    return { status: response.status, data: await response.json() };
  }
  async login(identity: string, value = password) {
    const result = await this.call("/auth/login", "POST", {
      identity: identity.includes("@") ? identity : `${identity}@baotin.local`,
      password: value,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
  }
}
test(
  "Operations API on a disposable local schema",
  { timeout: 120000 },
  async (t) => {
    const schema = `operations_qa_${randomBytes(6).toString("hex")}`;
    const sql = new Client({ connectionString: process.env.DATABASE_URL });
    await sql.connect();
    // Exercise schema upgrades with a persisted pre-release account, not just empty tables.
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`CREATE TABLE "${schema}".users (
      id uuid PRIMARY KEY, email varchar NOT NULL UNIQUE, phone varchar UNIQUE,
      name varchar NOT NULL, "passwordHash" varchar NOT NULL, role varchar NOT NULL,
      "customerId" varchar, branches text NOT NULL, profile jsonb NOT NULL DEFAULT '{}'
    )`);
    const legacyUserId = randomUUID();
    await sql.query(
      `INSERT INTO "${schema}".users (id,email,name,"passwordHash",role,branches) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        legacyUserId,
        "legacy@example.test",
        "Legacy staff",
        "unusable-test-hash",
        "sales",
        "Quy Nhơn",
      ],
    );
    const child = spawn(process.execPath, ["dist/main.js"], {
      env: {
        ...process.env,
        ENV_FILE: ".env.local",
        PORT: "4003",
        HOST: "127.0.0.1",
        DB_SCHEMA: schema,
        DB_SYNCHRONIZE: "true",
        NODE_ENV: "development",
        DB_SSL: "false",
        COOKIE_SECURE: "false",
        SEED_MOCK_DATA: "true",
        SEED_PASSWORD: password,
        KIOTVIET_ENABLED: "false",
        KIOTVIET_BRANCH_MAP: "{}",
        SMTP_URL: "",
        EMAIL_FROM: "",
        FRONTEND_URL: "http://localhost:3010",
        FRONTEND_ORIGINS: "http://localhost:3010",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => {
      logs += data;
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    const admin = new Actor(),
      sales = new Actor(),
      warehouse = new Actor(),
      accountant = new Actor(),
      b2b = new Actor(),
      guest = new Actor();
    const branch = "Quy Nhơn",
      productId = "LED-12V-8W";
    const command = async (
      actor: Actor,
      action: string,
      id: string | undefined,
      payload: object = {},
      orderId = id,
    ) => {
      const state = (await admin.call("/admin/state")).data;
      const expectedRevision = state.orders.find(
        (order: AdminOrder) => order.id === orderId,
      )?.revision;
      return actor.call("/admin/commands", "POST", {
        branch,
        action,
        id,
        payload,
        expectedRevision,
      });
    };
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null)
          throw new Error(`QA server failed: ${logs}`);
        const ready = await fetch(`${base}/health`)
          .then((r) => r.ok)
          .catch(() => false);
        if (ready) break;
        if (attempt === 99) throw new Error("QA API startup timed out");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.login("admin");
      await sales.login("sales");
      await warehouse.login("warehouse");
      await accountant.login("accountant");
      await b2b.login("kh001");
      const legacy = (
        await sql.query(
          `SELECT revision,disabled FROM "${schema}".users WHERE id=$1`,
          [legacyUserId],
        )
      ).rows[0];
      assert.equal(legacy.revision, 1);
      assert.equal(legacy.disabled, false);
      const product = (await guest.call("/catalog")).data.products.find(
        (p: { id: string }) => p.id === productId,
      );
      await t.test(
        "Pricing CRUD, overlap, stale revisions, guest isolation and customer override",
        async () => {
          const input = {
            branch,
            name: "Group test",
            scope: "group",
            target: "Xưởng nội thất",
            discount: 20,
            prices: {},
            startsOn: "2020-01-01",
            endsOn: null,
            active: true,
          };
          assert.equal(
            (await sales.call("/admin/pricing", "POST", input)).status,
            403,
          );
          const group = await admin.call("/admin/pricing", "POST", input);
          assert.equal(group.status, 201);
          assert.equal(
            (await admin.call("/admin/pricing", "POST", input)).status,
            409,
          );
          assert.equal(
            (await b2b.call("/catalog")).data.products.find(
              (p: { id: string }) => p.id === productId,
            ).customerPrice,
            Math.round(product.price * 0.8),
          );
          const specific = await admin.call("/admin/pricing", "POST", {
            ...input,
            scope: "customer",
            target: "KH001",
            prices: { [productId]: 12345 },
          });
          assert.equal(specific.status, 201);
          assert.equal(
            (await b2b.call("/catalog")).data.products.find(
              (p: { id: string }) => p.id === productId,
            ).customerPrice,
            12345,
          );
          assert.equal(
            (await guest.call("/catalog")).data.products.find(
              (p: { id: string }) => p.id === productId,
            ).customerPrice,
            undefined,
          );
          assert.equal(
            (
              await admin.call("/admin/pricing", "POST", {
                ...specific.data,
                revision: specific.data.revision - 1,
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await admin.call("/admin/pricing", "POST", {
                ...specific.data,
                name: "Updated customer policy",
              })
            ).status,
            201,
          );
          assert.equal(
            (await admin.call("/admin/pricing", "POST", specific.data)).status,
            409,
          );
          assert.equal(
            (await sales.call("/admin/pricing?branch=Tuy%20H%C3%B2a")).status,
            403,
          );
        },
      );
      const body = {
        items: [{ productId, quantity: 2 }],
        customer: {
          name: "Test website",
          phone: "0901234567",
          email: "",
          address: "123 test",
          city: "Test city",
          district: "Test district",
          ward: "",
        },
        delivery: "Giao hàng nội thành",
        payment: "Thanh toán khi nhận hàng (COD)",
        note: "QA",
        coupon: "BAOTIN10",
      };
      let websiteId = "";
      await t.test(
        "Website edits requote, retain shipping/discount, enforce totals and revision",
        async () => {
          const website = await guest.call("/orders", "POST", body);
          assert.equal(website.status, 201);
          websiteId = website.data.id;
          const draft = {
            branch,
            id: websiteId,
            customerId: "",
            source: "Website B2C",
            items: [{ productId, quantity: 3 }],
            details: {
              recipient: "Test website",
              phone: "0901234567",
              address: "123 test, Test city",
              delivery: "Giao nội thành",
              payment: "Tiền mặt",
              note: "Updated",
            },
          };
          const quote = await sales.call("/admin/orders/quote", "POST", draft);
          assert.equal(quote.status, 201);
          assert.equal(quote.data.subtotal, product.price * 3);
          assert.equal(quote.data.shipping, 30000);
          assert.equal(
            quote.data.discount,
            Math.min(100000, Math.round(product.price * 0.3)),
          );
          const { branch: _branch, id: _id, ...payload } = draft;
          assert.equal(
            (
              await command(sales, "save-order", websiteId, {
                ...payload,
                reason: "QA edit",
                expectedTotal: 1,
              })
            ).status,
            409,
          );
          const saved = await command(sales, "save-order", websiteId, {
            ...payload,
            reason: "QA edit",
            expectedTotal: quote.data.total,
          });
          assert.equal(saved.status, 201, JSON.stringify(saved.data));
          assert.equal(
            (await guest.call("/orders")).data.find(
              (o: AdminOrder) => o.id === websiteId,
            ).total,
            quote.data.total,
          );
          const changed = { ...draft, source: "Zalo" };
          assert.equal(
            (await sales.call("/admin/orders/quote", "POST", changed)).status,
            400,
          );
          assert.equal(
            (await command(sales, "advance-order", websiteId)).status,
            201,
          );
          assert.equal(
            (await sales.call("/admin/orders/quote", "POST", draft)).status,
            409,
          );
          assert.equal(
            (
              await command(sales, "cancel-order", websiteId, {
                reason: "Release QA reservation",
              })
            ).status,
            201,
          );
        },
      );
      await t.test(
        "Stock reservation, parallel confirmation, release and one-time physical issue",
        async () => {
          const before = (
            await admin.call(
              `/admin/ledger?branch=${encodeURIComponent(branch)}`,
            )
          ).data.inventory.find((p: { id: string }) => p.id === productId);
          assert.equal(
            (
              await admin.call("/admin/ledger/adjust", "POST", {
                branch,
                kind: "stock",
                id: productId,
                expected: before.onHand,
                target: before.reserved + 5,
                reason: "QA counted balance",
              })
            ).status,
            201,
          );
          const ids = [];
          for (let index = 0; index < 2; index++) {
            const order = await guest.call("/orders", "POST", {
              ...body,
              items: [{ productId, quantity: 3 }],
              coupon: "",
            });
            assert.equal(order.status, 201);
            ids.push(order.data.id);
          }
          const confirmed = await Promise.all(
            ids.map((id) => command(sales, "advance-order", id)),
          );
          assert.deepEqual(confirmed.map((r) => r.status).sort(), [201, 409]);
          const id = ids[confirmed.findIndex((r) => r.status === 201)];
          const stock = (await guest.call("/catalog")).data.products.find(
            (p: { id: string }) => p.id === productId,
          ).stock;
          assert.equal(stock, 2);
          assert.equal(
            (await command(warehouse, "advance-order", id)).status,
            201,
          );
          assert.equal(
            (
              await command(warehouse, "pick-item", id, {
                productId,
                picked: true,
              })
            ).status,
            201,
          );
          assert.equal(
            (await command(warehouse, "advance-order", id)).status,
            201,
          );
          assert.equal(
            (await command(warehouse, "advance-order", id)).status,
            201,
          );
          assert.equal((await command(sales, "advance-order", id)).status, 201);
          assert.equal(
            (await guest.call("/catalog")).data.products.find(
              (p: { id: string }) => p.id === productId,
            ).stock,
            2,
          );
          const entries = (
            await sql.query(
              `SELECT * FROM "${schema}".ledger_entries WHERE reference=$1`,
              [`order:${id}:stock:${productId}`],
            )
          ).rows;
          assert.equal(entries.length, 1);
          assert.equal(Number(entries[0].delta), -3);
          assert.equal(
            (
              await warehouse.call(
                `/admin/ledger?branch=${encodeURIComponent(branch)}`,
              )
            ).data.customers.length,
            0,
          );
        },
      );
      await t.test(
        "Credit reservation, invoice handoff, receipt reconciliation/reversal exactly once",
        async () => {
          const customer = (
            await admin.call(
              `/admin/ledger?branch=${encodeURIComponent(branch)}`,
            )
          ).data.customers.find((c: { id: string }) => c.id === "KH001");
          const terms = {
            branch,
            id: customer.id,
            expected: customer.limit,
            expectedGroup: customer.group,
            expectedTermsDays: customer.termsDays ?? 30,
            limit: customer.limit,
            group: customer.group,
            termsDays: 14,
            reason: "QA payment terms",
          };
          assert.equal(
            (await sales.call("/admin/ledger/terms", "POST", terms)).status,
            403,
          );
          assert.equal(
            (await admin.call("/admin/ledger/terms", "POST", terms)).status,
            201,
          );
          assert.equal(
            (await admin.call("/admin/ledger/terms", "POST", terms)).status,
            409,
          );
          const before = (await b2b.call("/auth/session")).data.user.customer
            .debt;
          const order = await b2b.call("/orders", "POST", {
            ...body,
            items: [{ productId, quantity: 1 }],
            coupon: "",
            delivery: "Nhận tại cửa hàng",
            payment: "Thanh toán công nợ B2B",
          });
          assert.equal(order.status, 201);
          const id = order.data.id,
            total = order.data.total;
          assert.equal(total, 12345);
          assert.equal((await command(sales, "advance-order", id)).status, 201);
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.creditReserved,
            total,
          );
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.debt,
            before,
          );
          await command(warehouse, "advance-order", id);
          await command(warehouse, "pick-item", id, {
            productId,
            picked: true,
          });
          await command(warehouse, "advance-order", id);
          const issue = await command(warehouse, "advance-order", id);
          assert.equal(issue.status, 201, JSON.stringify(issue.data));
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.debt,
            before + total,
          );
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.creditReserved,
            0,
          );
          const due = new Date(
            `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date())}T00:00:00Z`,
          );
          due.setUTCDate(due.getUTCDate() + 14);
          assert.equal(
            (await admin.call("/admin/state")).data.paymentDueDates[id],
            due.toISOString().slice(0, 10),
          );
          const draft = {
            orderId: id,
            amount: 5000,
            date: new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Ho_Chi_Minh",
            }).format(new Date()),
            reference: `QA-${randomUUID()}`,
            method: "Chuyển khoản",
            note: "QA",
          };
          const receipt = await command(
            accountant,
            "create-receipt",
            undefined,
            draft,
          );
          assert.equal(receipt.status, 201);
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.debt,
            before + total,
          );
          const check = {
            amount: draft.amount,
            reference: draft.reference,
            note: "QA reconciled",
          };
          assert.equal(
            (
              await command(
                accountant,
                "reconcile-receipt",
                receipt.data.id,
                check,
              )
            ).status,
            201,
          );
          assert.equal(
            (
              await command(
                accountant,
                "reconcile-receipt",
                receipt.data.id,
                check,
              )
            ).status,
            409,
          );
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.debt,
            before + total - 5000,
          );
          assert.equal(
            (
              await command(accountant, "void-receipt", receipt.data.id, {
                reason: "QA reversal",
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await command(accountant, "void-receipt", receipt.data.id, {
                reason: "QA reversal",
              })
            ).status,
            409,
          );
          assert.equal(
            (await b2b.call("/auth/session")).data.user.customer.debt,
            before + total,
          );
          assert.equal((await b2b.call("/account")).data.payments.length, 3);
        },
      );
      await t.test(
        "Opening overdue stays settled after a new debit and reverses with its payment",
        async () => {
          const source = await new DataSource({
            type: "postgres",
            url: process.env.DATABASE_URL,
            schema,
            entities,
            synchronize: false,
          }).initialize();
          try {
            const ledger = new LedgerService({ source } as DatabaseService);
            const customer = await source
              .getRepository(CustomerEntity)
              .findOneByOrFail({ id: "KH002" });
            const reference = `qa:opening:${randomUUID()}`;
            const original = customer.data.overdue;
            assert.ok(original > 0);
            await source.transaction((manager) =>
              ledger.credit(
                manager,
                customer.id,
                -customer.data.debt,
                reference,
                "qa",
                "QA full settlement",
              ),
            );
            let balance = await source
              .getRepository(CreditEntity)
              .findOneByOrFail({ customerId: customer.id });
            assert.equal(balance.debt, 0);
            assert.equal(balance.openingOverdue, 0);
            await source.transaction((manager) =>
              ledger.credit(
                manager,
                customer.id,
                1000,
                `${reference}:new`,
                "qa",
                "QA new debit",
              ),
            );
            balance = await source
              .getRepository(CreditEntity)
              .findOneByOrFail({ customerId: customer.id });
            assert.equal(balance.openingOverdue, 0);
            const payment = await source
              .getRepository(LedgerEntity)
              .findOneByOrFail({ reference });
            assert.equal(payment.openingOverdueDelta, -original);
            await source.transaction((manager) =>
              ledger.credit(
                manager,
                customer.id,
                customer.data.debt,
                `${reference}:reverse`,
                "qa",
                "QA reversal",
                -payment.openingOverdueDelta,
              ),
            );
            balance = await source
              .getRepository(CreditEntity)
              .findOneByOrFail({ customerId: customer.id });
            assert.equal(balance.debt, customer.data.debt + 1000);
            assert.equal(balance.openingOverdue, original);
          } finally {
            await source.destroy();
          }
        },
      );
      await t.test("Optimized stock matches full-history calculations and excludes other branches", async () => {
        const source = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL, schema, entities, synchronize: false }).initialize();
        try {
          const ledger = new LedgerService({ source } as DatabaseService);
          const products = (await source.getRepository(ProductEntity).find()).map(row => row.data);
          const before = await source.getRepository(OrderEntity).find({ where: { branch: "Quy Nhơn" } });
          const baseOrder = before[0].data;
          const prefix = `stock-qa-${randomUUID()}`;
          const quantities = [2, 3, 4, 700, 500];
          const statuses = ["Chờ soạn hàng", "Đang soạn", "Sẵn sàng giao", "Hoàn tất", "Đã hủy"] as const;
          await source.getRepository(OrderEntity).save(statuses.map((status, index) => ({
            id: `${prefix}-${index}`, branch: "Quy Nhơn", customerId: null, guestId: null,
            data: { ...baseOrder, id: `${prefix}-${index}`, status, items: [{ productId: products[0].id, quantity: quantities[index], unitPrice: products[0].price }] },
          })));
          await source.getRepository(OrderEntity).save({ id: `${prefix}-other`, branch: "Tuy Hòa", customerId: null, guestId: null, data: { ...baseOrder, id: `${prefix}-other`, branch: "Tuy Hòa", status: "Chờ soạn hàng", items: [{ productId: products[0].id, quantity: 900, unitPrice: products[0].price }] } });
          const allOrders = (await source.getRepository(OrderEntity).find({ where: { branch: "Quy Nhơn" } })).map(row => row.data);
          const balances = await source.getRepository(InventoryEntity).find({ where: { branch: "Quy Nhơn" } });
          for (const except of [undefined, `${prefix}-0`]) {
            const result = await ledger.stock(products, "Quy Nhơn", source.manager, except);
            for (const product of result) {
              const onHand = balances.find(row => row.productId === product.id)?.onHand ?? products.find(row => row.id === product.id)!.stock;
              const reserved = reservedQuantity(allOrders, product.id, except);
              assert.equal(product.onHand, onHand);
              assert.equal(product.reserved, reserved);
              assert.equal(product.stock, Math.max(0, onHand - reserved));
            }
          }
          assert.deepEqual(await ledger.stock([], "Quy Nhơn"), []);
          const single = await ledger.stock([products[0]], "Quy Nhơn");
          assert.equal(single[0].reserved, reservedQuantity(allOrders, products[0].id));
        } finally { await source.destroy(); }
      });
      await t.test(
        "Accounts, branch grants, last admin guard, password change and token single-use",
        async () => {
          const users = await admin.call("/admin/users");
          assert.ok(
            users.data.users.every(
              (user: object) => !Object.hasOwn(user, "passwordHash"),
            ),
          );
          assert.equal((await sales.call("/admin/users")).status, 403);
          const self = users.data.users.find(
            (user: { email: string }) => user.email === "admin@baotin.local",
          );
          const { customerId: _customerId, ...selfInput } = self;
          assert.equal(
            (
              await admin.call("/admin/users", "POST", {
                ...selfInput,
                disabled: true,
              })
            ).status,
            409,
          );
          const created = await admin.call("/admin/users", "POST", {
            name: "QA Staff",
            email: "qa-staff@example.test",
            role: "sales",
            branches: [branch],
            disabled: false,
            password,
          });
          assert.equal(created.status, 201);
          const createdUser = (
            await admin.call("/admin/users")
          ).data.users.find(
            (user: { id: string }) => user.id === created.data.id,
          );
          const { customerId: _createdCustomer, ...edit } = createdUser;
          edit.name = "QA Staff Updated";
          assert.equal(
            (await admin.call("/admin/users", "POST", edit)).status,
            201,
          );
          assert.equal(
            (await admin.call("/admin/users", "POST", edit)).status,
            409,
          );
          const staff = new Actor();
          await staff.login("qa-staff@example.test");
          assert.equal(
            (await staff.call("/admin/ledger?branch=Tuy%20H%C3%B2a")).status,
            403,
          );
          const nextPassword = `${password}-new`;
          assert.equal(
            (
              await staff.call("/auth/change-password", "POST", {
                currentPassword: "incorrect-password",
                password: nextPassword,
              })
            ).status,
            401,
          );
          const oldCookie = staff.cookie;
          assert.equal(
            (
              await staff.call("/auth/change-password", "POST", {
                currentPassword: password,
                password: nextPassword,
              })
            ).status,
            201,
          );
          staff.cookie = oldCookie;
          assert.equal((await staff.call("/admin/state")).status, 401);
          await staff.login("qa-staff@example.test", nextPassword);
          const token = randomBytes(32).toString("hex"),
            hash = createHash("sha256").update(token).digest("hex");
          await sql.query(
            `INSERT INTO "${schema}".password_resets ("tokenHash","userId","expiresAt") VALUES ($1,$2,$3)`,
            [hash, created.data.id, new Date(Date.now() + 60000)],
          );
          const expired = randomBytes(32).toString("hex");
          await sql.query(
            `INSERT INTO "${schema}".password_resets ("tokenHash","userId","expiresAt") VALUES ($1,$2,$3)`,
            [
              createHash("sha256").update(expired).digest("hex"),
              created.data.id,
              new Date(Date.now() - 60000),
            ],
          );
          assert.equal(
            (
              await guest.call("/auth/reset-password", "POST", {
                token: expired,
                password: `${password}-reset`,
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await guest.call("/auth/reset-password", "POST", {
                token,
                password: `${password}-reset`,
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await guest.call("/auth/reset-password", "POST", {
                token,
                password: `${password}-reset`,
              })
            ).status,
            400,
          );
          assert.equal((await staff.call("/admin/state")).status, 401);
          assert.equal(
            (
              await admin.call(
                `/admin/users/${created.data.id}/password`,
                "POST",
                { password },
              )
            ).status,
            201,
          );
          assert.equal(
            (
              await guest.call("/auth/forgot-password", "POST", {
                email: "qa-staff@example.test",
              })
            ).status,
            503,
          );
          const audit = JSON.stringify(
            (
              await sql.query(
                `SELECT detail FROM "${schema}".audit_events WHERE "resourceId"=$1`,
                [created.data.id],
              )
            ).rows,
          );
          assert.ok(!audit.includes(password));
          assert.ok(!audit.includes(token));
        },
      );
      await t.test(
        "Kiot writes are off by default; mocked outbox rejects ambiguous duplicate sends",
        async () => {
          assert.equal(
            (
              await sales.call(
                `/admin/integrations/kiotviet?branch=${encodeURIComponent(branch)}`,
              )
            ).status,
            403,
          );
          const configuration = (
            await admin.call(
              `/admin/integrations/kiotviet?branch=${encodeURIComponent(branch)}`,
            )
          ).data;
          assert.equal(configuration.enabled, false);
          assert.equal(configuration.configured, false);
          assert.equal(configuration.clientSecret, undefined);
          const source = new DataSource({
            type: "postgres",
            url: process.env.DATABASE_URL,
            schema,
            entities,
            synchronize: false,
          });
          await source.initialize();
          const db = new DatabaseService();
          db.source = source;
          const adminUser = (await source
            .getRepository(UserEntity)
            .findOneBy({ email: "admin@baotin.local" }))!;
          let requests = 0;
          const client = {
            configuration: () => ({
              enabled: true,
              configured: true,
              branches: { [branch]: 12 },
            }),
            request: async () => {
              requests++;
              throw new Error("Simulated response lost after remote creation");
            },
            list: async () => [{ id: 456, description: "[BAOTIN:KIOT-QA]" }],
          } as unknown as KiotClient;
          try {
            const order = {
              id: "KIOT-QA",
              branch,
              customerId: null,
              customerName: "Guest",
              channel: "B2C",
              source: "Inside Sales",
              date: "2026-10-05",
              status: "Chờ soạn hàng",
              total: 45000,
              credit: false,
              items: [{ productId, quantity: 1, unitPrice: 45000 }],
              details: {
                recipient: "Guest",
                phone: "0901234567",
                address: "",
                delivery: "Nhận tại cửa hàng",
                payment: "Tiền mặt",
                note: "",
              },
            };
            await sql.query(
              `INSERT INTO "${schema}".orders (id,branch,data,warehouse,revision) VALUES ($1,$2,$3,$4,1)`,
              [order.id, branch, order, { checks: {}, history: [] }],
            );
            await sql.query(
              `INSERT INTO "${schema}".integration_links (id,kind,"localId","externalId",snapshot) VALUES ($1,$2,$3,$4,$5)`,
              [
                `product:${productId}`,
                "product",
                productId,
                "789",
                { code: product.code, unit: product.unit },
              ],
            );
            const service = new KiotService(db, client);
            await assert.rejects(
              service.exportOrder(adminUser, branch, order.id, 1),
            );
            await assert.rejects(
              service.exportOrder(adminUser, branch, order.id, 1),
            );
            assert.equal(requests, 1);
            process.env.KIOTVIET_BRANCH_MAP = JSON.stringify({ [branch]: 12 });
            assert.equal(
              (await service.reconcile(adminUser, branch, order.id)).externalId,
              "456",
            );
            assert.equal(
              (await service.exportOrder(adminUser, branch, order.id, 1))
                .externalId,
              "456",
            );
            assert.equal(requests, 1);
          } finally {
            await source.destroy();
          }
        },
      );
    } finally {
      const stopped =
        child.exitCode === null ? once(child, "exit") : Promise.resolve();
      child.kill("SIGTERM");
      await stopped;
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  },
);
