import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { priceFor } from "../src/catalog/pricing";
import { validateReceipt, reconciliationBlocker } from "../src/admin/rules/accounting.rules";
import { warehouseBlocker } from "../src/admin/rules/warehouse.rules";
import { readFile } from "node:fs/promises";
import type { AdminOrder, Product } from "../src/types/domain.types";

test("Passwords use salted scrypt and reject wrong passwords", async () => {
  const first = await hashPassword("a-long-test-password");
  const second = await hashPassword("a-long-test-password");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a-long-test-password", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
});
test("Backend domain guards retain mock rules", async () => {
  const fixture = JSON.parse(await readFile("seed/mock.json", "utf8"));
  const product: Product = fixture.products[0];
  assert.equal(priceFor(product, null), product.price);
  const order: AdminOrder = { ...fixture.orders[0], status: "Đang soạn", total: 100000 };
  assert.ok(warehouseBlocker(order, { checks: {}, history: [] }));
  const draft = { orderId: order.id, amount: 100001, date: order.date, reference: "TEST", method: "Chuyển khoản" as const, note: "" };
  assert.ok(validateReceipt(draft, order, [], order.date));
  const receipt = { ...draft, amount: 50000, id: "TEST", branch: order.branch, status: "Chờ đối chiếu" as const, createdAt: new Date().toISOString() };
  assert.ok(reconciliationBlocker(receipt, 40000, "TEST", "checked", []));
  assert.equal(reconciliationBlocker(receipt, 50000, "TEST", "checked", []), "");
});
