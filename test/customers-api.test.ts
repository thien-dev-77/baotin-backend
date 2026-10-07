import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local", quiet: true });
if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).hostname !== "127.0.0.1"
)
  throw new Error("Customer QA only runs on local PostgreSQL.");
const base = "http://127.0.0.1:4006/api";
const branch = "Quy Nhơn";
class Actor {
  cookie = "";
  async call(path: string, method = "GET", body?: object) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: "http://localhost:3010",
        "X-BaoTin-Client": "web",
        Cookie: this.cookie,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.headers.getSetCookie().length)
      this.cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
    return { status: response.status, data: await response.json() };
  }
}

test(
  "Customer management, phone onboarding and financial isolation",
  { timeout: 120000 },
  async (t) => {
    const schema = `customers_qa_${randomBytes(6).toString("hex")}`;
    const password = `QA-${randomBytes(16).toString("hex")}`;
    const sql = new Client({ connectionString: process.env.DATABASE_URL });
    await sql.connect();
    const child = spawn(process.execPath, ["dist/main.js"], {
      env: {
        ...process.env,
        ENV_FILE: ".env.local",
        PORT: "4006",
        HOST: "127.0.0.1",
        DB_SCHEMA: schema,
        DB_SYNCHRONIZE: "true",
        DB_SSL: "false",
        NODE_ENV: "development",
        COOKIE_SECURE: "false",
        SEED_MOCK_DATA: "true",
        SEED_PASSWORD: password,
        FRONTEND_ORIGINS: "http://localhost:3010",
        KIOTVIET_ENABLED: "false",
        KIOTVIET_POLL_ENABLED: "false",
        SMTP_URL: "",
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
      accountant = new Actor(),
      warehouse = new Actor(),
      guest = new Actor(),
      created = new Actor();
    const list = async () =>
      (
        await admin.call(
          `/admin/customers?branch=${encodeURIComponent(branch)}`,
        )
      ).data;
    const get = async (id: string) =>
      (await list()).items.find((row: any) => row.id === id);
    const input = (phone: string, extra: object = {}) => ({
      branch,
      name: "Xưởng QA mới",
      contact: "Khách QA",
      phone,
      email: "",
      tax: "",
      address: "Quy Nhơn",
      group: "Xưởng nội thất",
      assignedSalesId: null,
      pilot: false,
      notes: "",
      ...extra,
    });
    const patch = (row: any, extra: object = {}) =>
      input(row.phone, {
        name: row.name,
        contact: row.contact,
        email: row.email,
        tax: row.tax,
        address: row.address,
        group: row.group,
        assignedSalesId: row.assignedSalesId || null,
        pilot: row.pilot || false,
        notes: row.notes || "",
        revision: row.revision,
        ...extra,
      });
    let id = "",
      offlineId = "",
      salesId = "";
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
        [accountant, "accountant"],
        [warehouse, "warehouse"],
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
      salesId = (await list()).assignees.find((row: any) => !row.disabled).id;

      await t.test(
        "Role and branch boundaries protect customer records",
        async () => {
          for (const actor of [warehouse]) {
            assert.equal(
              (
                await actor.call(
                  `/admin/customers?branch=${encodeURIComponent(branch)}`,
                )
              ).status,
              403,
            );
            assert.equal(
              (
                await actor.call(
                  "/admin/customers",
                  "POST",
                  input("0908000100"),
                )
              ).status,
              403,
            );
          }
          assert.equal(
            (
              await guest.call(
                `/admin/customers?branch=${encodeURIComponent(branch)}`,
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await accountant.call(
                `/admin/customers?branch=${encodeURIComponent(branch)}`,
              )
            ).status,
            200,
          );
          assert.equal(
            (
              await accountant.call(
                "/admin/customers",
                "POST",
                input("0908000100"),
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await sales.call(
                `/admin/customers?branch=${encodeURIComponent("Tuy Hòa")}`,
              )
            ).status,
            403,
          );
          assert.equal(
            (await admin.call("/admin/customers?branch=unknown")).status,
            400,
          );
          assert.equal(
            (
              await admin.call(
                "/admin/customers",
                "POST",
                input("0908000100", { debt: 900000, limit: 900000 }),
              )
            ).status,
            400,
          );
        },
      );
      await t.test(
        "Pilot records require an enabled Sales in the same branch",
        async () => {
          assert.equal(
            (
              await sales.call(
                "/admin/customers",
                "POST",
                input("0908000100", { pilot: true }),
              )
            ).status,
            400,
          );
          const adminId = (await admin.call("/auth/session")).data.user.id;
          assert.equal(
            (
              await sales.call(
                "/admin/customers",
                "POST",
                input("0908000100", { pilot: true, assignedSalesId: adminId }),
              )
            ).status,
            400,
          );
          const other = await admin.call("/admin/users", "POST", {
            name: "Sales chi nhánh khác",
            email: "other-sales@example.test",
            role: "sales",
            branches: ["Tuy Hòa"],
            disabled: false,
            password,
          });
          assert.equal(other.status, 201);
          assert.equal(
            (
              await sales.call(
                "/admin/customers",
                "POST",
                input("0908000100", {
                  pilot: true,
                  assignedSalesId: other.data.id,
                }),
              )
            ).status,
            400,
          );
        },
      );
      await t.test(
        "Sales can create a phone-only account without granting credit",
        async () => {
          const result = await sales.call(
            "/admin/customers",
            "POST",
            input("0908 000 100", {
              password,
              pilot: true,
              assignedSalesId: salesId,
              notes: "Khách thử nghiệm tuần đầu",
            }),
          );
          assert.equal(result.status, 201);
          id = result.data.id;
          assert.equal(result.data.accountCreated, true);
          const row = await get(id);
          assert.equal(row.phone, "0908000100");
          assert.equal(row.email, "");
          assert.equal(row.pilot, true);
          assert.ok(row.account.id);
          const login = await created.call("/auth/login", "POST", {
            identity: row.phone,
            password,
          });
          assert.equal(login.status, 201);
          assert.equal(login.data.user.email, "");
          assert.equal(login.data.user.customer.status, "pending");
          assert.equal(
            (
              await created.call(
                `/admin/customers?branch=${encodeURIComponent(branch)}`,
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await created.call(
                "/admin/customers",
                "POST",
                input("0908000101"),
              )
            ).status,
            403,
          );
          const state = (await admin.call("/admin/state")).data.customers.find(
            (row: any) => row.id === id,
          );
          assert.equal(state.limit, 0);
          assert.equal(state.debt, 0);
          assert.equal(state.assignedSalesId, salesId);
          assert.equal(state.revision, row.revision);
          const raw = (
            await sql.query(
              `SELECT email FROM "${schema}".users WHERE "customerId"=$1`,
              [id],
            )
          ).rows[0];
          assert.equal(raw.email, null);
          assert.equal(JSON.stringify(row).includes("passwordHash"), false);
          assert.equal(
            (
              await admin.call("/admin/commands", "POST", {
                action: "customer-status",
                branch,
                id,
                payload: { status: "Đang hoạt động", revision: row.revision },
              })
            ).status,
            201,
          );
        },
      );
      await t.test(
        "Duplicates and invalid values are rejected atomically",
        async () => {
          assert.equal(
            (
              await sales.call(
                "/admin/customers",
                "POST",
                input("0908 000 100"),
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await sales.call(
                "/admin/customers",
                "POST",
                input("0908000101", { email: "admin@baotin.local" }),
              )
            ).status,
            409,
          );
          assert.equal(
            (await sales.call("/admin/customers", "POST", input("abcdefghi")))
              .status,
            400,
          );
          assert.equal(
            (
              await sales.call(
                "/admin/customers",
                "POST",
                input("0908000101", { name: "  " }),
              )
            ).status,
            400,
          );
          const results = await Promise.all([
            sales.call("/admin/customers", "POST", input("0908000102")),
            sales.call("/admin/customers", "POST", input("0908000102")),
          ]);
          assert.deepEqual(
            results.map((result) => result.status).sort(),
            [201, 409],
          );
        },
      );
      await t.test(
        "Editing preserves balances and account preferences, while stale revisions fail",
        async () => {
          const row = await get(id);
          await created.call("/account/preferences", "PATCH", {
            settings: [true, false, true],
          });
          const before = (await admin.call("/admin/state")).data.customers.find(
            (row: any) => row.id === id,
          );
          const result = await sales.call(
            `/admin/customers/${id}`,
            "PATCH",
            patch(row, {
              name: "Xưởng QA cập nhật",
              address: "Địa chỉ mới",
              tax: "1234567890",
              group: "Thiết kế - thi công",
              notes: "Đã hướng dẫn đặt đơn",
            }),
          );
          assert.equal(result.status, 200);
          assert.ok(result.data.revision > row.revision);
          assert.equal(
            (await sales.call(`/admin/customers/${id}`, "PATCH", patch(row)))
              .status,
            409,
          );
          const after = (await admin.call("/admin/state")).data.customers.find(
            (row: any) => row.id === id,
          );
          for (const key of [
            "limit",
            "debt",
            "overdue",
            "creditReserved",
            "termsDays",
          ])
            assert.equal(after[key], before[key]);
          const account = (await created.call("/account")).data;
          assert.deepEqual(account.settings, [true, false, true]);
          assert.equal(account.user.customer.company, "Xưởng QA cập nhật");
          assert.equal(account.user.customer.tax, "1234567890");
          const seeded = await get("KH001");
          const financial = (
            await admin.call("/admin/state")
          ).data.customers.find((row: any) => row.id === "KH001");
          assert.equal(
            (
              await sales.call(
                "/admin/customers/KH001",
                "PATCH",
                patch(seeded, { notes: "Khách cũ đang có đơn và công nợ" }),
              )
            ).status,
            200,
          );
          const preserved = (
            await admin.call("/admin/state")
          ).data.customers.find((row: any) => row.id === "KH001");
          assert.equal(preserved.limit, financial.limit);
          assert.equal(preserved.debt, financial.debt);
        },
      );
      await t.test(
        "Linked login email cannot be taken over through the customer profile",
        async () => {
          const row = await get(id);
          assert.equal(
            (
              await sales.call(
                `/admin/customers/${id}`,
                "PATCH",
                patch(row, { email: "takeover@example.test" }),
              )
            ).status,
            400,
          );
          const foreign = (
            await admin.call(
              `/admin/customers?branch=${encodeURIComponent("Tuy Hòa")}`,
            )
          ).data.items.find((row: any) => row.id === "KH005");
          assert.equal(
            (
              await sales.call("/admin/customers/KH005", "PATCH", {
                ...patch(foreign),
                branch: "Tuy Hòa",
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await sales.call("/admin/customers/KH005", "PATCH", {
                ...patch(foreign),
                branch,
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        "Changing login phone revokes old sessions and keeps the same password",
        async () => {
          const row = await get(id);
          assert.equal(
            (
              await sales.call(
                `/admin/customers/${id}`,
                "PATCH",
                patch(row, { phone: "0908000199" }),
              )
            ).status,
            200,
          );
          assert.equal((await created.call("/auth/session")).data.user, null);
          assert.equal(
            (
              await created.call("/auth/login", "POST", {
                identity: "0908000100",
                password,
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await created.call("/auth/login", "POST", {
                identity: "0908000199",
                password,
              })
            ).status,
            201,
          );
          const current = await get(id);
          assert.equal(
            (
              await created.call("/account/profile", "PATCH", {
                name: current.contact,
                company: current.name,
                phone: current.phone,
                email: "",
                tax: current.tax,
                address: current.address,
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "Offline profiles can be onboarded later without duplicate public registration",
        async () => {
          const result = await sales.call(
            "/admin/customers",
            "POST",
            input("0908000200"),
          );
          assert.equal(result.status, 201);
          offlineId = result.data.id;
          assert.equal((await get(offlineId)).account, null);
          assert.equal(
            (
              await guest.call("/auth/register", "POST", {
                name: "QA Khách",
                company: "QA Company",
                email: "public@example.test",
                phone: "0908000200",
                password,
              })
            ).status,
            409,
          );
          const row = await get(offlineId);
          assert.equal(
            (
              await sales.call(
                `/admin/customers/${offlineId}/account`,
                "POST",
                { branch, revision: row.revision + 1, password },
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await sales.call(
                `/admin/customers/${offlineId}/account`,
                "POST",
                { branch, revision: row.revision, password },
              )
            ).status,
            201,
          );
          const linked = await get(offlineId);
          assert.ok(linked.revision > row.revision);
          assert.ok(linked.account);
          assert.equal(
            (
              await sales.call(
                `/admin/customers/${offlineId}/account`,
                "POST",
                {
                  branch,
                  revision: linked.revision,
                  password: `${password}new`,
                },
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await new Actor().call("/auth/login", "POST", {
                identity: linked.phone,
                password,
              })
            ).status,
            201,
          );
        },
      );
      await t.test(
        "Status and financial-policy updates invalidate stale profile edits",
        async () => {
          const row = await get(id);
          const state = (await admin.call("/admin/state")).data.customers.find(
            (row: any) => row.id === id,
          );
          assert.equal(
            (
              await admin.call("/admin/ledger/terms", "POST", {
                branch,
                id,
                expected: state.limit,
                expectedGroup: state.group,
                expectedTermsDays: state.termsDays ?? 30,
                limit: 1000000,
                group: state.group,
                termsDays: 14,
                reason: "Chính sách khách QA được duyệt",
              })
            ).status,
            201,
          );
          assert.equal(
            (await sales.call(`/admin/customers/${id}`, "PATCH", patch(row)))
              .status,
            409,
          );
          const current = await get(id);
          assert.equal(
            (
              await admin.call("/admin/commands", "POST", {
                action: "customer-status",
                branch,
                id,
                payload: { status: "Tạm ngưng", revision: current.revision },
              })
            ).status,
            201,
          );
          assert.equal(
            (
              await sales.call(
                `/admin/customers/${id}`,
                "PATCH",
                patch(current),
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await admin.call("/admin/commands", "POST", {
                action: "customer-status",
                branch,
                id,
                payload: {
                  status: "Đang hoạt động",
                  revision: current.revision,
                },
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "Audits contain no passwords and creation defaults remain explicit",
        async () => {
          const events = (
            await sql.query(
              `SELECT action, detail FROM "${schema}".audit_events WHERE "resourceId" = ANY($1)`,
              [[id, offlineId]],
            )
          ).rows;
          assert.ok(events.some((row) => row.action === "customer-create"));
          assert.ok(events.some((row) => row.action === "customer-update"));
          assert.ok(
            events.some((row) => row.action === "customer-account-create"),
          );
          assert.equal(JSON.stringify(events).includes(password), false);
          assert.equal(JSON.stringify(events).includes("passwordHash"), false);
          const nullEmails = (
            await sql.query(
              `SELECT count(*)::int AS count FROM "${schema}".users WHERE email IS NULL`,
            )
          ).rows[0].count;
          assert.ok(nullEmails >= 2);
          const data = await list();
          assert.equal(JSON.stringify(data).includes("passwordHash"), false);
          assert.equal(JSON.stringify(data).includes("favorites"), false);
          const warehouseState = (await warehouse.call("/admin/state")).data;
          const privateProfile = warehouseState.customers.find((row: any) => row.id === id);
          assert.equal(privateProfile.notes, undefined);
          assert.equal(privateProfile.email, undefined);
          assert.equal(privateProfile.assignedSalesId, undefined);
        },
      );
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  },
);
