import test from "node:test";
import assert from "node:assert/strict";
import { discountedPrice, defaultB2bPrice, publicProduct, redactProductPricing, resolveProductPricing, retailPrice } from "../dist/catalog/product-pricing";
import { policyPrice } from "../dist/catalog/price-policy.service";
import type { Product, AdminCustomer } from "../src/types/domain.types";
import type { PricePolicy } from "../src/types/operations.types";

const product: Product = { id: "QA", code: "QA", slug: "qa", name: "QA", brand: "QA", category: "led-tu-ke", subcategory: "LED dây", unit: "cái", image: "/images/qa.jpg", gallery: ["/images/qa.jpg"], specification: "QA", material: "", color: "", size: "", origin: "", stock: 10, featured: false, price: 80000, listPrice: 100000, b2cDiscount: 20, b2bDiscount: 35 };
const customer: AdminCustomer = { id: "QA-CUSTOMER", name: "QA", contact: "QA", phone: "0901234567", group: "Xưởng nội thất", branch: "Quy Nhơn", status: "Đang hoạt động", limit: 0, debt: 0, overdue: 0 };
const policy: PricePolicy = { id: "QA-POLICY", name: "QA", branch: "Quy Nhơn", scope: "group", target: customer.group, discount: 10, prices: {}, startsOn: "2000-01-01", endsOn: null, active: true, revision: 1 };

test("Discounts use list price independently, round whole VND and handle fractional percentages exactly", () => {
  assert.equal(retailPrice(product), 80000); assert.equal(defaultB2bPrice(product), 65000);
  assert.equal(discountedPrice(101, 50), 51);
  assert.equal(discountedPrice(100000, 12.34), 87660);
  assert.equal(discountedPrice(999999999999, 50), 500000000000);
  assert.equal(discountedPrice(1, 99.99), 1); assert.equal(discountedPrice(0, 20), 0);
});
test("Policy prices override product defaults without stacking B2C discounts; legacy policies retain their basis", () => {
  assert.equal(policyPrice(product, customer, [], "2026-10-12"), 65000);
  assert.equal(policyPrice(product, customer, [policy], "2026-10-12"), 90000);
  assert.equal(policyPrice(product, customer, [{ ...policy, prices: { QA: 50000 } }], "2026-10-12"), 50000);
  assert.equal(policyPrice(product, undefined, [policy], "2026-10-12"), 80000);
  assert.equal(policyPrice(product, { ...customer, status: "Tạm ngưng" }, [policy], "2026-10-12"), 80000);
  const { listPrice: _list, b2cDiscount: _b2c, b2bDiscount: _b2b, ...legacy } = product;
  assert.equal(policyPrice({ ...legacy, oldPrice: 100000 }, customer, [policy], "2026-10-12"), 72000);
});
test("Server derives prices, rejects incomplete or invalid configuration, and keeps legacy prices unchanged", () => {
  const result = resolveProductPricing({ listPrice: 100000, b2cDiscount: 20, b2bDiscount: 35, price: 1 });
  assert.equal(result.price, 80000); assert.equal(result.oldPrice, 100000);
  assert.deepEqual(resolveProductPricing({ price: 80000, oldPrice: 100000 }, product), result);
  assert.deepEqual(resolveProductPricing({ price: 45000, oldPrice: 56000 }), { price: 45000, oldPrice: 56000 });
  for (const input of [{ listPrice: 1 }, { listPrice: 100000, b2cDiscount: 100, b2bDiscount: 1 }, { listPrice: -1, b2cDiscount: 0, b2bDiscount: 0 }, { listPrice: 1, b2cDiscount: 1.001, b2bDiscount: 0 }, {}]) assert.throws(() => resolveProductPricing(input));
  assert.throws(() => resolveProductPricing({ price: 1 }, product));
});
test("Retail and warehouse projections never expose private B2B configuration and do not mutate source data", () => {
  const original = { ...product, customerPrice: 65000 };
  const retail = publicProduct(original);
  assert.equal(retail.price, 80000); assert.equal(retail.listPrice, 100000);
  assert.ok(!("b2bDiscount" in retail)); assert.ok(!("customerPrice" in retail));
  const warehouse = redactProductPricing(original);
  for (const field of ["listPrice", "b2cDiscount", "b2bDiscount", "oldPrice", "customerPrice"]) assert.ok(!(field in warehouse));
  assert.equal(warehouse.price, 0); assert.equal(original.b2bDiscount, 35);
});
