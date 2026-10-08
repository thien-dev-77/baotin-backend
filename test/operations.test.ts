import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { policyPrice, validDate } from "../dist/catalog/price-policy.service";
import { reservedQuantity, reservedQuantities } from "../dist/ledger/ledger.service";
import {
  branchMap,
  KiotClient,
  KiotHttpError,
} from "../dist/integrations/kiot-client";
import {
  orderMarker,
  uncertainStatus,
} from "../dist/integrations/kiot.service";
import { resetDigest } from "../dist/auth/password-recovery.service";
import { PasswordRecoveryService } from "../dist/auth/password-recovery.service";
import nodemailer from "nodemailer";
import type { PricePolicy } from "../src/types/operations.types";
import type { AdminOrder } from "../src/types/domain.types";

test("Pricing precedence, effective dates, branch scope and retail fallback", async () => {
  const fixture = JSON.parse(await readFile("seed/mock.json", "utf8"));
  const customer = fixture.customers[0],
    product = fixture.products[0];
  const base: PricePolicy = {
    id: "default",
    name: "Test",
    branch: customer.branch,
    scope: "default",
    target: "",
    discount: 10,
    prices: {},
    startsOn: "2026-01-01",
    endsOn: null,
    active: true,
    revision: 1,
  };
  const group = {
    ...base,
    id: "group",
    scope: "group" as const,
    target: customer.group,
    discount: 20,
  };
  const specific = {
    ...base,
    id: "customer",
    scope: "customer" as const,
    target: customer.id,
    prices: { [product.id]: 12345 },
  };
  assert.equal(
    policyPrice(product, customer, [base, group, specific], "2026-10-05"),
    12345,
  );
  assert.equal(
    policyPrice(product, customer, [base, group], "2026-10-05"),
    Math.round(product.price * 0.8),
  );
  assert.equal(
    policyPrice(
      product,
      customer,
      [{ ...base, endsOn: "2026-01-01" }],
      "2026-10-05",
    ),
    product.price,
  );
  assert.equal(
    policyPrice(
      product,
      { ...customer, branch: "Tuy Hòa" },
      [base],
      "2026-10-05",
    ),
    product.price,
  );
  assert.equal(
    policyPrice(
      product,
      { ...customer, status: "Chờ duyệt" },
      [base],
      "2026-10-05",
    ),
    product.price,
  );
  assert.equal(
    policyPrice(product, undefined, [specific], "2026-10-05"),
    product.price,
  );
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2028-02-29"), true);
});
test("Reservations apply only to confirmed, unissued orders and support exclusions", () => {
  const order = {
    id: "a",
    status: "Chờ soạn hàng",
    items: [{ productId: "sku", quantity: 5, unitPrice: 1 }],
  } as AdminOrder;
  assert.equal(
    reservedQuantity(
      [order, { ...order, id: "b", status: "Chờ xác nhận" }],
      "sku",
    ),
    5,
  );
  assert.equal(reservedQuantity([order], "sku", "a"), 0);
  for (const status of ["Đã hủy", "Đang giao", "Hoàn tất"] as const)
    assert.equal(reservedQuantity([{ ...order, status }], "sku"), 0);
});
test("Reservation maps preserve exclusions, stages and first-line semantics", () => {
  const row = { id: "first", status: "Chờ soạn hàng", items: [{ productId: "a", quantity: 2 }, { productId: "b", quantity: 3 }, { productId: "a", quantity: 99 }] } as AdminOrder;
  const rows = [row, { ...row, id: "second", status: "Đang soạn", items: [{ productId: "a", quantity: 4 }] }, { ...row, id: "finished", status: "Hoàn tất" }] as AdminOrder[];
  assert.deepEqual([...reservedQuantities(rows)], [["a", 6], ["b", 3]]);
  assert.equal(reservedQuantities(rows, "first").get("a"), 4);
  assert.equal(reservedQuantities(rows, "first").has("b"), false);
  assert.equal(reservedQuantity(rows, "unknown"), 0);
  assert.equal(reservedQuantities([]).size, 0);
});

test("Recovery digests and Kiot mapping/uncertain outcomes never enable blind retries", () => {
  assert.equal(resetDigest("token").length, 64);
  assert.notEqual(resetDigest("token"), "token");
  assert.deepEqual(branchMap('{"Quy Nhơn":12}'), { "Quy Nhơn": 12 });
  assert.throws(() => branchMap('{"Quy Nhơn":12,"Tuy Hòa":12}'));
  assert.throws(() => branchMap('{"unknown":1}'));
  assert.equal(uncertainStatus(new Error("Timeout")), "uncertain");
  assert.equal(uncertainStatus(new KiotHttpError(500)), "uncertain");
  assert.equal(uncertainStatus(new KiotHttpError(422)), "failed");
  assert.equal(orderMarker("BT-123"), "[BAOTIN:BT-123]");
});
test("Kiot OAuth, fixed origins, pagination and sanitized vendor failures", async () => {
  const original = globalThis.fetch;
  const keys = [
    "KIOTVIET_ENABLED",
    "KIOTVIET_RETAILER",
    "KIOTVIET_CLIENT_ID",
    "KIOTVIET_CLIENT_SECRET",
    "KIOTVIET_BRANCH_MAP",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KIOTVIET_ENABLED: "true",
    KIOTVIET_RETAILER: "test",
    KIOTVIET_CLIENT_ID: "test",
    KIOTVIET_CLIENT_SECRET: "fake-secret",
    KIOTVIET_BRANCH_MAP: "{}",
  });
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes("/connect/token")) {
      assert.ok(String(options?.body).includes("scopes=PublicApi.Access"));
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      "Bearer fake-token",
    );
    const offset = Number(new URL(String(url)).searchParams.get("currentItem"));
    return Response.json({
      total: 101,
      data: Array.from({ length: offset === 0 ? 100 : 1 }, (_, index) => ({
        id: index + offset + 1,
        code: "TEST",
      })),
    });
  };
  try {
    const client = new KiotClient();
    const rows = await client.list("products");
    assert.equal(rows.length, 101);
    assert.equal(calls.length, 3);
    await assert.rejects(client.request("https://untrusted.example"));
    globalThis.fetch = async () =>
      Response.json({ privateSecret: "do-not-log" }, { status: 503 });
    await assert.rejects(
      client.request("/orders"),
      (error) =>
        error instanceof KiotHttpError && !error.message.includes("do-not-log"),
    );
  } finally {
    globalThis.fetch = original;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
test("Recovery email uses a fragment token and stores only its hash; unknown accounts get the same reply", async () => {
  const original = nodemailer.createTransport;
  const keys = ["SMTP_URL", "EMAIL_FROM", "FRONTEND_URL", "NODE_ENV"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    SMTP_URL: "smtp://fake.example.test",
    EMAIL_FROM: "test@example.test",
    FRONTEND_URL: "https://example.test",
    NODE_ENV: "production",
  });
  let email = "",
    stored: { tokenHash: string } | undefined;
  const deleted: object[] = [];
  nodemailer.createTransport = (() => ({
    sendMail: async (value: { text: string }) => {
      email = value.text;
    },
    close: () => {},
  })) as typeof original;
  const repository = {
    findOneBy: async ({ email }: { email: string }) =>
      email === "registered@example.test" ? { id: "test-user", email } : null,
    delete: async (value: object) => {
      deleted.push(value);
    },
    save: async (value: { tokenHash: string }) => {
      stored = value;
    },
  };
  const manager = { getRepository: () => repository };
  const service = new PasswordRecoveryService({
    source: manager,
    transaction: async (work: (value: typeof manager) => unknown) =>
      work(manager),
  });
  try {
    const known = await service.forgot("registered@example.test");
    const unknown = await service.forgot("missing@example.test");
    assert.deepEqual(known, unknown);
    const match = email.match(
      /https:\/\/example\.test\/reset-password#token=([a-f0-9]{64})/,
    );
    assert.ok(match);
    assert.equal(stored?.tokenHash, resetDigest(match[1]));
    assert.ok(!JSON.stringify(stored).includes(match[1]));
    nodemailer.createTransport = (() => ({
      sendMail: async () => {
        throw new Error("Private SMTP diagnostic");
      },
      close: () => {},
    })) as typeof original;
    assert.deepEqual(await service.forgot("registered@example.test"), unknown);
    assert.deepEqual(deleted.at(-1), { tokenHash: stored?.tokenHash });
  } finally {
    nodemailer.createTransport = original;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
