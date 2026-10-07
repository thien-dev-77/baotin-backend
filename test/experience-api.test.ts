import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import { agingBucket } from "../src/reports/report.rules";
import { frequentProductIds } from "../src/account/customer-actions.rules";
import { DataSource } from "typeorm";
import { entities, UserEntity, ProductEntity } from "../dist/database/entities";
import { DatabaseService } from "../dist/database/database.service";
import {
  IntegrationLinkEntity,
  LedgerEntity,
  InventoryEntity,
  CreditEntity,
} from "../dist/database/operations.entities";
import { KiotClient } from "../dist/integrations/kiot-client";
import { KiotService } from "../dist/integrations/kiot.service";
import { KiotReconciliationService } from "../dist/integrations/kiot-reconciliation.service";
import { LedgerService } from "../dist/ledger/ledger.service";
import { NotificationsService } from "../dist/notifications/notifications.service";

config({ path: ".env.local", quiet: true });
if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw new Error("Experience QA only runs against local PostgreSQL.");
const base = "http://127.0.0.1:4005/api";
class Actor {
  cookie = "";
  async call(
    path: string,
    method = "GET",
    body?: object,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: "http://localhost:3010",
        "X-BaoTin-Client": "web",
        Cookie: this.cookie,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const jar = new Map(
      this.cookie
        .split("; ")
        .filter(Boolean)
        .map((value) => {
          const index = value.indexOf("=");
          return [value.slice(0, index), value.slice(index + 1)];
        }),
    );
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0];
      const index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    this.cookie = [...jar]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const data = response.headers
      .get("content-type")
      ?.includes("application/pdf")
      ? Buffer.from(await response.arrayBuffer())
      : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
}
test("Aging boundaries and frequent purchase ranking", () => {
  assert.equal(agingBucket(null, "2026-10-07"), "unknown");
  assert.equal(agingBucket("2026-10-07", "2026-10-07"), "current");
  assert.equal(agingBucket("2026-10-06", "2026-10-07"), "days30");
  assert.equal(agingBucket("2026-08-01", "2026-10-07"), "days90");
  assert.equal(agingBucket("2026-01-01", "2026-10-07"), "older");
  assert.deepEqual(
    frequentProductIds([
      {
        items: [
          { productId: "b", quantity: 2 },
          { productId: "a", quantity: 1 },
        ],
      },
      { items: [{ productId: "a", quantity: 5 }] },
    ]),
    ["a", "b"],
  );
});

test(
  "Experience APIs use isolated data, ownership, revisions and real persistence",
  { timeout: 120000 },
  async (t) => {
    const schema = `experience_qa_${randomBytes(6).toString("hex")}`;
    const password = `QA-${randomBytes(16).toString("hex")}`;
    const sql = new Client({ connectionString: process.env.DATABASE_URL });
    await sql.connect();
    const child = spawn(process.execPath, ["dist/main.js"], {
      env: {
        ...process.env,
        ENV_FILE: ".env.local",
        PORT: "4005",
        HOST: "127.0.0.1",
        DB_SCHEMA: schema,
        DB_SYNCHRONIZE: "true",
        DB_SSL: "false",
        NODE_ENV: "development",
        COOKIE_SECURE: "false",
        SEED_MOCK_DATA: "true",
        SEED_PASSWORD: password,
        FRONTEND_ORIGINS: "http://localhost:3010",
        SMTP_URL: "",
        KIOTVIET_ENABLED: "false",
        KIOTVIET_POLL_ENABLED: "false",
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
      customer = new Actor(),
      other = new Actor(),
      guest = new Actor();
    let product: any,
      orderId = "",
      approvalId = "",
      lead: any;
    const state = async () => (await admin.call("/admin/state")).data;
    const command = async (
      action: string,
      id: string,
      payload: object = {},
    ) => {
      const current = await state();
      const row = current.orders.find((row: any) => row.id === orderId);
      return admin.call("/admin/commands", "POST", {
        action,
        id,
        branch: "Quy Nhơn",
        expectedRevision: row?.revision,
        payload,
      });
    };
    try {
      for (let i = 0; i < 150; i++) {
        if (child.exitCode !== null) throw new Error(logs);
        if (
          await fetch(`${base}/health`)
            .then((response) => response.ok)
            .catch(() => false)
        )
          break;
        if (i === 149) throw new Error(logs);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const [actor, name] of [
        [admin, "admin"],
        [sales, "sales"],
        [warehouse, "warehouse"],
        [customer, "kh001"],
        [other, "kh002"],
      ] as const)
        assert.equal(
          (
            await actor.call("/auth/login", "POST", {
              identity: `${name}@baotin.local`,
              password,
            })
          ).status,
          201,
        );
      product = (await customer.call("/catalog")).data.products.find(
        (row: any) => row.stock > 10 && row.price > 10,
      );
      await t.test(
        "New consultation creates scoped notifications and editable lead",
        async () => {
          const created = await guest.call("/contact/consultations", "POST", {
            name: "Khách QA",
            phone: "0901234567",
            email: "qa@example.test",
            message: "Tư vấn phụ kiện nội thất",
          });
          assert.equal(created.status, 201);
          const result = (
            await admin.call("/contact/consultations?branch=Quy%20Nhơn")
          ).data;
          lead = result.items.find((row: any) => row.id === created.data.id);
          assert.ok(lead);
          assert.equal(
            (await warehouse.call("/contact/consultations")).status,
            403,
          );
          assert.equal(
            (await customer.call("/contact/consultations")).status,
            403,
          );
          assert.equal(
            (await sales.call("/contact/consultations?branch=Tuy%20Hòa"))
              .status,
            403,
          );
          const payload = {
            revision: lead.revision,
            status: "contacted",
            assignedTo: result.assignees[0].id,
            note: "Đã gọi, chờ bản vẽ.",
          };
          assert.equal(
            (
              await admin.call(
                `/contact/consultations/${lead.id}`,
                "PATCH",
                payload,
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await admin.call(
                `/contact/consultations/${lead.id}`,
                "PATCH",
                payload,
              )
            ).status,
            409,
          );
          assert.equal(
            (await admin.call("/contact/consultations")).data.items[0].note,
            payload.note,
          );
        },
      );
      await t.test(
        "Notifications paginate, mark once and never expose another recipient",
        async () => {
          assert.equal((await guest.call("/notifications")).status, 401);
          const inbox = (await admin.call("/notifications")).data;
          assert.equal(inbox.unreadCount, 1);
          assert.equal(inbox.items[0].type, "consultation");
          assert.equal(
            (
              await customer.call("/notifications/read", "PATCH", {
                id: inbox.items[0].id,
              })
            ).data.updated,
            0,
          );
          assert.equal(
            (
              await admin.call("/notifications/read", "PATCH", {
                id: inbox.items[0].id,
              })
            ).data.updated,
            1,
          );
          assert.equal(
            (
              await admin.call("/notifications/read", "PATCH", {
                id: inbox.items[0].id,
              })
            ).data.updated,
            0,
          );
          assert.equal(
            (await admin.call("/notifications?unread=true")).data.total,
            0,
          );
        },
      );
      await t.test(
        "Checkout idempotency emits one notification per recipient",
        async () => {
          const key = randomUUID();
          const input = {
            items: [{ productId: product.id, quantity: 1 }],
            customer: {
              name: "Khách QA",
              phone: "0901234567",
              email: "",
              address: "",
              city: "",
              district: "",
              ward: "",
            },
            delivery: "Nhận tại cửa hàng",
            payment: "Thanh toán khi nhận hàng (COD)",
            note: "",
            coupon: "",
          };
          const created = await customer.call("/orders", "POST", input, {
            "Idempotency-Key": key,
          });
          assert.equal(created.status, 201, JSON.stringify(created.data));
          orderId = created.data.id;
          assert.equal(
            (
              await customer.call("/orders", "POST", input, {
                "Idempotency-Key": key,
              })
            ).data.id,
            orderId,
          );
          assert.equal(
            (await customer.call("/notifications")).data.items.filter(
              (item: any) => item.title.includes(orderId),
            ).length,
            1,
          );
          assert.equal(
            (await other.call("/notifications")).data.items.filter(
              (item: any) => item.title.includes(orderId),
            ).length,
            0,
          );
        },
      );
      await t.test(
        "Customer price requests reuse the staff approval workflow",
        async () => {
          const row = (
            await customer.call("/account/price-requests")
          ).data.orders.find((row: any) => row.id === orderId);
          const payload = {
            orderId,
            revision: row.revision,
            reason: "Đề nghị giá cho công trình QA",
            prices: { [product.id]: row.items[0].unitPrice - 1 },
          };
          assert.equal(
            (await other.call("/account/price-requests", "POST", payload))
              .status,
            403,
          );
          const created = await customer.call(
            "/account/price-requests",
            "POST",
            payload,
          );
          assert.equal(created.status, 201, JSON.stringify(created.data));
          approvalId = created.data.id;
          assert.equal(
            (await customer.call("/account/price-requests", "POST", payload))
              .status,
            409,
          );
          assert.equal(
            (
              await command("decide-approval", approvalId, {
                approved: true,
                reason: "Duyệt theo nhu cầu QA",
              })
            ).status,
            201,
          );
          assert.equal(
            (await customer.call("/account/price-requests")).data.items.find(
              (item: any) => item.id === approvalId,
            ).status,
            "Đã duyệt",
          );
        },
      );
      await t.test(
        "PDF documents are valid binary, private and ownership checked",
        async () => {
          const pdf = await customer.call(
            `/orders/${orderId}/document?kind=quote`,
          );
          assert.equal(pdf.status, 200);
          assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
          assert.ok(pdf.data.length > 5000);
          assert.match(pdf.headers.get("cache-control")!, /private/);
          assert.equal(
            (await other.call(`/orders/${orderId}/document`)).status,
            403,
          );
          assert.equal(
            (await guest.call(`/orders/${orderId}/document`)).status,
            403,
          );
          assert.equal(
            (await warehouse.call(`/admin/orders/${orderId}/document`)).status,
            403,
          );
          assert.equal(
            (await admin.call(`/admin/orders/${orderId}/document`)).status,
            200,
          );
        },
      );
      await t.test(
        "Delivered purchases drive frequent products and verified reviews",
        async () => {
          for (let step = 0; step < 2; step++)
            assert.equal((await command("advance-order", orderId)).status, 201);
          const warehouseNotice = (
            await warehouse.call("/notifications")
          ).data.items.find((row: any) => row.title.includes(orderId));
          assert.equal(
            warehouseNotice.href,
            `/admin/warehouse?order=${orderId}`,
          );
          assert.equal(
            (
              await command("pick-item", orderId, {
                productId: product.id,
                picked: true,
              })
            ).status,
            201,
          );
          for (let step = 0; step < 3; step++)
            assert.equal((await command("advance-order", orderId)).status, 201);
          assert.ok(
            (
              await customer.call("/account/frequently-bought")
            ).data.products.some((row: any) => row.id === product.id),
          );
          assert.equal(
            (
              await guest.call(`/reviews/${product.id}`, "POST", {
                stars: 5,
                text: "Sản phẩm tốt",
              })
            ).status,
            401,
          );
          const review = await customer.call(`/reviews/${product.id}`, "POST", {
            stars: 5,
            text: "Phụ kiện đúng mã, chất lượng tốt.",
          });
          assert.equal(review.status, 201);
          assert.equal(
            (
              await customer.call(`/reviews/${product.id}`, "POST", {
                stars: 4,
                text: "Đánh giá trùng",
              })
            ).status,
            409,
          );
          assert.ok(
            !(await guest.call(`/reviews/${product.id}`)).data.items.some(
              (row: any) => row.id === review.data.id,
            ),
          );
          const pending = (await admin.call("/admin/reviews")).data.items.find(
            (row: any) => row.id === review.data.id,
          );
          assert.equal(
            (
              await admin.call(`/admin/reviews/${pending.id}`, "PATCH", {
                revision: pending.revision,
                status: "published",
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await admin.call(`/admin/reviews/${pending.id}`, "PATCH", {
                revision: pending.revision,
                status: "rejected",
              })
            ).status,
            409,
          );
          assert.ok(
            (await guest.call(`/reviews/${product.id}`)).data.items.some(
              (row: any) => row.id === pending.id,
            ),
          );
        },
      );
      await t.test(
        "CMS persists changes, separates drafts and rejects unsafe paths",
        async () => {
          assert.equal((await customer.call("/admin/content")).status, 403);
          const existing = (await admin.call("/admin/content")).data.items[0];
          const draft = {
            ...existing.data,
            slug: `qa-${randomUUID()}`,
            title: "Hướng dẫn QA",
            body: "Nội dung tiếng Việt đã lưu.",
            kind: "guide",
            published: false,
          };
          const created = await admin.call("/admin/content", "POST", draft);
          assert.equal(created.status, 201, JSON.stringify(created.data));
          assert.ok(
            !(await guest.call("/content")).data.items.some(
              (row: any) => row.id === created.data.id,
            ),
          );
          assert.equal(
            (
              await admin.call(`/admin/content/${created.data.id}`, "PATCH", {
                ...draft,
                published: true,
                revision: created.data.revision,
              })
            ).status,
            200,
          );
          assert.ok(
            (await guest.call("/content")).data.items.some(
              (row: any) =>
                row.id === created.data.id && row.body === draft.body,
            ),
          );
          assert.equal(
            (
              await admin.call("/admin/content", "POST", {
                ...draft,
                slug: `${draft.slug}-x`,
                href: "//evil.test",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await admin.call("/admin/content", "POST", {
                ...draft,
                slug: `${draft.slug}-y`,
                image: "/images/../../secret.jpg",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await admin.call(`/admin/content/${created.data.id}`, "PATCH", {
                ...draft,
                revision: created.data.revision,
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "Reports reconcile debt buckets, enforce branch/role and deduplicate reminders",
        async () => {
          const report = await admin.call(
            "/admin/reports?branch=Quy%20Nhơn&days=30",
          );
          assert.equal(report.status, 200);
          assert.ok(report.data.selfOrders >= 1);
          for (const row of report.data.aging)
            assert.equal(
              row.current +
                row.days30 +
                row.days60 +
                row.days90 +
                row.older +
                row.unknown,
              Math.max(0, row.debt),
            );
          assert.equal(
            (await warehouse.call("/admin/reports?branch=Quy%20Nhơn")).status,
            403,
          );
          assert.equal(
            (await sales.call("/admin/reports?branch=Tuy%20Hòa")).status,
            403,
          );
          const overdue = report.data.aging.find((row: any) => row.overdue > 0);
          if (overdue) {
            const payload = { branch: "Quy Nhơn", customerId: overdue.id };
            await admin.call("/admin/reports/remind", "POST", payload);
            await admin.call("/admin/reports/remind", "POST", payload);
            assert.equal(
              (
                await admin.call("/notifications?type=credit")
              ).data.items.filter((row: any) =>
                row.message.includes(overdue.name),
              ).length,
              1,
            );
          }
        },
      );
      await t.test(
        "Kiot disabled state cannot accidentally modify financial balances",
        async () => {
          const before = (await admin.call("/admin/ledger?branch=Quy%20Nhơn"))
            .data;
          assert.equal(
            (
              await admin.call("/admin/integrations/kiotviet/pull", "POST", {
                branch: "Quy Nhơn",
              })
            ).status,
            503,
          );
          assert.equal(
            (
              await warehouse.call(
                "/admin/integrations/kiotviet/pull",
                "POST",
                { branch: "Quy Nhơn" },
              )
            ).status,
            403,
          );
          assert.deepEqual(
            (await admin.call("/admin/ledger?branch=Quy%20Nhơn")).data,
            before,
          );
        },
      );
      await t.test(
        "Kiot snapshots validate remote values, retain successful history and never write balances",
        async () => {
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
          const user = (await source
            .getRepository(UserEntity)
            .findOneBy({ email: "admin@baotin.local" }))!;
          const localProduct = (await source
            .getRepository(ProductEntity)
            .findOneBy({ id: product.id }))!.data;
          const balances = async () => ({
            inventory: await source
              .getRepository(InventoryEntity)
              .find({ order: { id: "ASC" } }),
            credit: await source
              .getRepository(CreditEntity)
              .find({ order: { customerId: "ASC" } }),
            ledger: await source.getRepository(LedgerEntity).count(),
          });
          let malformed = false,
            fail = false;
          const client = {
            configuration: () => ({
              enabled: true,
              configured: true,
              branches: { "Quy Nhơn": 12 },
            }),
            list: async (resource: string) => {
              if (fail) throw new Error("Simulated Kiot connection error");
              if (resource === "products")
                return [
                  {
                    id: 11,
                    code: localProduct.code,
                    unit: localProduct.unit,
                    inventories: [
                      { branchId: 12, onHand: malformed ? null : 123 },
                    ],
                  },
                ];
              if (resource === "customers")
                return [{ id: 22, debt: malformed ? null : 456 }];
              return [{ id: 33, status: 1, statusValue: "Đã xác nhận" }];
            },
          } as unknown as KiotClient;
          try {
            await source.getRepository(IntegrationLinkEntity).save([
              {
                id: `product:${product.id}`,
                kind: "product",
                localId: product.id,
                externalId: "11",
                snapshot: { code: localProduct.code, unit: localProduct.unit },
              },
              {
                id: "customer:KH001",
                kind: "customer",
                localId: "KH001",
                externalId: "22",
                snapshot: { branch: "Quy Nhơn" },
              },
              {
                id: `order:${orderId}`,
                kind: "order",
                localId: orderId,
                externalId: "33",
                snapshot: { branch: "Quy Nhơn" },
              },
            ]);
            const before = await balances();
            const service = new KiotReconciliationService(
              db,
              client,
              new KiotService(db, client),
              new LedgerService(db),
              new NotificationsService(db),
            );
            const completed = await service.pull(user, "Quy Nhơn");
            let snapshot = await service.latest(user, "Quy Nhơn");
            assert.equal((snapshot.run!.stock as any[])[0].remote, 123);
            assert.equal((snapshot.run!.debt as any[])[0].remote, 456);
            assert.equal(snapshot.run!.debtScope, "retailer");
            assert.equal(
              (snapshot.run!.statuses as any[])[0].remote,
              "Đã xác nhận",
            );
            assert.equal(snapshot.run!.id, completed.id);
            malformed = true;
            await service.pull(user, "Quy Nhơn");
            snapshot = await service.latest(user, "Quy Nhơn");
            assert.equal((snapshot.run!.stock as any[])[0].valid, false);
            assert.equal((snapshot.run!.debt as any[])[0].valid, false);
            const retained = snapshot.run!.id;
            fail = true;
            await assert.rejects(service.pull(user, "Quy Nhơn"));
            snapshot = await service.latest(user, "Quy Nhơn");
            assert.equal(snapshot.run!.id, retained);
            assert.equal(snapshot.lastAttempt!.status, "failed");
            await assert.rejects(
              service.latest(
                { ...user, role: "warehouse" } as UserEntity,
                "Quy Nhơn",
              ),
            );
            assert.deepEqual(await balances(), before);
          } finally {
            await source.destroy();
          }
        },
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  },
);
