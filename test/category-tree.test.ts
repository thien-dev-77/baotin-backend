import test from "node:test";
import assert from "node:assert/strict";
import { assertCategoryTree, categoryDescendants, categoryTrail } from "../src/catalog/category-tree";
import { FULCO_CATEGORIES, planFulcoTaxonomy } from "../src/catalog/fulco-taxonomy";
import { orderedCategories } from "../src/catalog/category.rules";
import type { Category, Product } from "../src/types/domain.types";
import type { CategoryEntity } from "../src/database/entities";

const category = (slug: string, parentSlug = ""): Category => ({ slug, name: slug, parentSlug, image: "/images/catalog/kitchen.png", description: "", subcategories: [], visible: true, sortOrder: 0 });
const original = () => FULCO_CATEGORIES.filter(item => item.existing).map(item => ({ slug: item.slug, data: category(item.slug), revision: 2 }));
const product = (code: string, category: string, group = "") => ({ id: code, data: { id: code, code, category, image: "/images/catalog/kitchen.png", gallery: ["/images/catalog/kitchen.png"], variantGroupId: group, price: 100000, b2cDiscount: 60, b2bDiscount: 65 } as Product, published: true, revision: 3 });

test("Trees include the root itself and every descendant, with bounded cyclic traversal", () => {
  const categories = [category("a"), category("b", "a"), category("c", "b"), category("d")];
  assert.deepEqual(categoryTrail(categories, "c").map(item => item.slug), ["a", "b", "c"]);
  assert.deepEqual(categoryDescendants(categories, "a"), ["a", "b", "c"]);
  assert.deepEqual(categoryDescendants(categories, "d"), ["d"]);
  assert.deepEqual(categoryTrail([category("a", "b"), category("b", "a")], "a"), []);
  assert.deepEqual(categoryDescendants([category("a", "b"), category("b", "a")], "a"), ["a", "b"]);
});
test("Reject missing parents, self-parenting, indirect cycles and excessive depth", () => {
  for (const categories of [[category("a", "missing")], [category("a", "a")], [category("a", "b"), category("b", "a")], [category("a"), category("b", "a"), category("c", "b"), category("d", "c"), category("e", "d")]]) assert.throws(() => assertCategoryTree(categories));
  assert.doesNotThrow(() => assertCategoryTree([category("a"), category("b", "a"), category("c", "b"), category("d", "c")]));
});
test("Hidden ancestors hide descendant navigation without changing their own visibility", () => {
  const rows = [{ slug: "a", data: { ...category("a"), visible: false }, revision: 1 }, { slug: "b", data: category("b", "a"), revision: 1 }] as CategoryEntity[];
  assert.equal(orderedCategories(rows, true).length, 0);
  assert.equal(orderedCategories(rows).length, 2);
  assert.equal(rows[1].data.visible, true);
});
test("Fulco preserves all original URLs, creates five roots, and separates mixed product families", () => {
  const categories = original();
  const products = [product("F11", "chau-voi-rua-bat"), product("FC-B7546-304", "chau-voi-rua-bat"), product("FCH203-700", "phu-kien-tu-quan-ao"), product("FC225", "phu-kien-noi-that"), product("FC99", "thiet-bi-bep-gia-dung"), product("FC115", "thiet-bi-bep-gia-dung")];
  const snapshot = JSON.stringify({ categories, products });
  const plan = planFulcoTaxonomy(categories, products);
  assert.equal(plan.summary.roots, 5);
  assert.equal(plan.summary.categoriesAfter, 44);
  assert.equal(plan.summary.added, 16);
  assert.equal(plan.products.find(item => item.code === "F11")?.to, "voi-rua");
  assert.equal(plan.products.find(item => item.code === "FC-B7546-304")?.to, "chau-rua");
  assert.equal(plan.products.find(item => item.code === "FCH203-700")?.to, "ngan-keo-de-do");
  assert.ok(categories.every(row => plan.tree.some(item => item.slug === row.slug)));
  assert.equal(plan.tree.find(item => item.slug === "ray-truot")?.visible, false);
  assert.equal(JSON.stringify({ categories, products }), snapshot);
});
test("Fulco preview is idempotent, keeps manually hidden categories, and refuses unknown classifications", () => {
  const categories = original();
  categories[0].data.visible = false;
  const products = [product("FC225", "phu-kien-noi-that")];
  const plan = planFulcoTaxonomy(categories, products);
  const newCategories = plan.tree.map(data => ({ slug: data.slug, data, revision: 3 }));
  const newProducts = products.map(row => ({ ...row, data: { ...row.data, category: plan.products.find(item => item.id === row.id)!.to } }));
  const repeated = planFulcoTaxonomy(newCategories, newProducts);
  assert.equal(repeated.categories.length, 0);
  assert.equal(repeated.products.length, 0);
  assert.equal(plan.tree.find(item => item.slug === categories[0].slug)?.visible, false);
  assert.throws(() => planFulcoTaxonomy(categories.slice(1), []), /Thiếu danh mục/);
  assert.throws(() => planFulcoTaxonomy(categories, [product("UNKNOWN", "phu-kien-tu-quan-ao")]), /Chưa phân loại/);
});
test("Fulco cannot split one variant family across categories", () => {
  assert.throws(() => planFulcoTaxonomy(original(), [product("F11", "chau-voi-rua-bat", "family"), product("FC-B7546-304", "chau-voi-rua-bat", "family")]), /bị tách danh mục/);
});
