import test from "node:test";
import assert from "node:assert/strict";
import { availableFacetGroups, inferredFacetGroups, matchesProductFacet, productFacetGroups, PRODUCT_FACETS, PRODUCT_FACET_FIELDS, type ProductFacetField } from "../src/catalog/product-filter-attributes";

const cases: [ProductFacetField, string, string[]][] = [
  ["color", "Màu đen mờ", ["black"]],
  ["color", "nâu đen, cuộn 25m", ["black", "brown"]],
  ["color", "Xám toàn phần", ["gray"]],
  ["color", "Màu ghi", ["gray"]],
  ["color", "Mạ Chrome bóng", ["silver"]],
  ["color", "Inox mờ", ["silver"]],
  ["color", "Champagne", ["gold"]],
  ["color", "Trắng / Đen", ["black", "white"]],
  ["color", "Xanh lá / Xanh dương", ["blue", "green"]],
  ["color", "Clear glass", ["transparent"]],
  ["color", "Màu theo yêu cầu", ["other"]],
  ["origin", "Made in Malaysia", ["malaysia"]],
  ["origin", "Đức", ["germany"]],
  ["origin", "Germany", ["germany"]],
  ["origin", "Thương hiệu Đức - sản xuất tại Trung Quốc", ["china"]],
  ["origin", "Xuất xứ: Việt Nam / Thailand", ["vietnam", "thailand"]],
  ["origin", "ITALIA", ["italy"]],
  ["origin", "Tây Ban Nha", ["spain"]],
  ["origin", "Hàn Quốc", ["korea"]],
  ["origin", "Chưa công bố", ["other"]],
  ["color", "", []], ["origin", "  ", []],
];
for (const [field, raw, expected] of cases) test(`${field}: ${raw || "empty"}`, () => assert.deepEqual(inferredFacetGroups(field, raw), expected));

test("Manual selections override text, including explicit empty arrays; null restores inference", () => {
  const product = { material: "Inox 304", color: "Đen", origin: "Germany", materialGroups: ["plastic"], colorGroups: ["white", "silver"], originGroups: [] };
  const before = structuredClone(product);
  assert.deepEqual(productFacetGroups(product, "material"), ["plastic"]);
  assert.deepEqual(productFacetGroups(product, "color"), ["white", "silver"]);
  assert.deepEqual(productFacetGroups(product, "origin"), []);
  assert.equal(matchesProductFacet(product, "material", ["inox-304"]), false);
  assert.equal(matchesProductFacet(product, "color", ["black", "silver"]), true);
  assert.equal(matchesProductFacet(product, "origin", []), true);
  assert.deepEqual(productFacetGroups({ ...product, materialGroups: null, originGroups: null }, "material"), ["inox-304"]);
  assert.deepEqual(productFacetGroups({ ...product, originGroups: null }, "origin"), ["germany"]);
  assert.deepEqual(product, before);
});

test("Published metadata is authoritative; selected empty-result groups remain removable", () => {
  assert.deepEqual(availableFacetGroups("color", ["Đen"], [], ["white"]).map(option => option.value), ["white"]);
  assert.deepEqual(availableFacetGroups("origin", ["Germany"], ["malaysia"], []).map(option => option.value), ["malaysia"]);
  assert.deepEqual(availableFacetGroups("color", ["Đen", "Black", "Xám"]).map(option => option.value), ["black", "gray"]);
  for (const field of PRODUCT_FACET_FIELDS) {
    const values = PRODUCT_FACETS[field].options.map(option => option.value);
    assert.equal(new Set(values).size, values.length);
    assert.deepEqual(productFacetGroups({ [`${field}Groups`]: ["invalid"] }, field), []);
  }
});
