import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";

config({ path: process.env.ENV_FILE || ".env", quiet: true });

const fixture = JSON.parse(await readFile(new URL("../seed/mock.json", import.meta.url), "utf8"));
const productIds = fixture.products.map(product => product.id);
const categorySlugs = fixture.categories.map(category => category.slug);
const fixtureOrderIds = new Set(fixture.orders.map(order => order.id));
const inventory = {
  fixtureProducts: productIds.length,
  fixtureCategories: categorySlugs.length,
  fixtureOrders: fixtureOrderIds.size,
  seedEnabled: process.env.SEED_MOCK_DATA === "true",
};

if (process.argv.includes("--fixture-only")) {
  console.log(JSON.stringify(inventory, null, 2));
  process.exit(0);
}

const schema = process.env.DB_SCHEMA || "baotin_app";
if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema) || ["public", "auth", "storage"].includes(schema)) {
  throw new Error("DB_SCHEMA must be a dedicated application schema.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the read-only database audit.");

const ssl = process.env.DB_SSL === "true"
  ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA_FILE ? { ca: await readFile(resolve(process.env.DB_SSL_CA_FILE), "utf8") } : {}) }
  : false;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, connectionTimeoutMillis: 7000 });
const table = name => `"${schema}"."${name}"`;
const summarize = rows => ({ count: rows.length, examples: rows.slice(0, 5) });
let connected = false;

try {
  await client.connect();
  connected = true;
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const query = async (sql, values) => (await client.query(sql, values)).rows;
  const products = await query(`SELECT id, slug, data, published FROM ${table("products")} WHERE id = ANY($1::text[])`, [productIds]);
  const categories = await query(`SELECT slug, data FROM ${table("categories")} WHERE slug = ANY($1::text[])`, [categorySlugs]);
  const productById = new Map(products.map(row => [row.id, row]));
  const categoryBySlug = new Map(categories.map(row => [row.slug, row]));
  const modifiedProducts = fixture.products.filter(item => {
    const row = productById.get(item.id);
    return row && (row.slug !== item.slug || row.published !== true || !isDeepStrictEqual(row.data, item));
  }).map(item => item.id);
  const modifiedCategories = fixture.categories.filter(item => {
    const row = categoryBySlug.get(item.slug);
    return row && !isDeepStrictEqual(row.data, item);
  }).map(item => item.slug);

  const orderItems = await query(`
    SELECT DISTINCT o.id AS ref, item->>'productId' AS "productId"
    FROM ${table("orders")} o
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.data->'items') = 'array' THEN o.data->'items' ELSE '[]'::jsonb END) item
    WHERE item->>'productId' = ANY($1::text[])
  `, [productIds]);
  const checkoutItems = await query(`
    SELECT DISTINCT o.id AS ref, item->>'productId' AS "productId"
    FROM ${table("orders")} o
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.checkout->'items') = 'array' THEN o.checkout->'items' ELSE '[]'::jsonb END) item
    WHERE item->>'productId' = ANY($1::text[])
  `, [productIds]);
  const orders = [...new Map([...orderItems, ...checkoutItems].map(row => [`${row.ref}:${row.productId}`, row])).values()];
  const stock = await query(`SELECT id AS ref, "productId" FROM ${table("inventory_balances")} WHERE "productId" = ANY($1::text[])`, [productIds]);
  const ledger = await query(`SELECT id AS ref, "resourceId" AS "productId" FROM ${table("ledger_entries")} WHERE kind = 'stock' AND "resourceId" = ANY($1::text[])`, [productIds]);
  const integrations = await query(`SELECT id AS ref, "localId" AS "productId" FROM ${table("integration_links")} WHERE kind = 'product' AND "localId" = ANY($1::text[])`, [productIds]);
  const reviews = await query(`SELECT id AS ref, "productId" FROM ${table("product_reviews")} WHERE "productId" = ANY($1::text[])`, [productIds]);
  const prices = await query(`
    SELECT p.id AS ref, price.product_id AS "productId"
    FROM ${table("price_policies")} p
    CROSS JOIN LATERAL jsonb_object_keys(COALESCE(p.data->'prices', '{}'::jsonb)) AS price(product_id)
    WHERE price.product_id = ANY($1::text[])
  `, [productIds]);
  const favorites = await query(`
    SELECT u.id AS ref, favorite.product_id AS "productId"
    FROM ${table("users")} u
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(u.profile->'favorites') = 'array' THEN u.profile->'favorites' ELSE '[]'::jsonb END) AS favorite(product_id)
    WHERE favorite.product_id = ANY($1::text[])
  `, [productIds]);
  const otherProductsInCategories = await query(`
    SELECT id AS ref, data->>'category' AS category
    FROM ${table("products")}
    WHERE data->>'category' = ANY($1::text[]) AND NOT (id = ANY($2::text[]))
  `, [categorySlugs, productIds]);
  const content = await query(`
    SELECT id AS ref, data->>'category' AS category, data->>'href' AS href
    FROM ${table("content_entries")}
    WHERE data->>'category' = ANY($1::text[]) OR data->>'href' = ANY($2::text[])
  `, [categorySlugs, categorySlugs.map(slug => `/category/${slug}`)]);
  await client.query("ROLLBACK");

  console.log(JSON.stringify({
    ...inventory,
    schema,
    found: { products: products.length, categories: categories.length },
    modified: { products: summarize(modifiedProducts), categories: summarize(modifiedCategories) },
    references: {
      mockOrders: summarize(orders.filter(row => fixtureOrderIds.has(row.ref))),
      otherOrders: summarize(orders.filter(row => !fixtureOrderIds.has(row.ref))),
      stock: summarize(stock), ledger: summarize(ledger), integrations: summarize(integrations),
      reviews: summarize(reviews), prices: summarize(prices), favorites: summarize(favorites),
      otherProductsInCategories: summarize(otherProductsInCategories), content: summarize(content),
    },
    note: "Read-only audit. No products, categories, orders or images were deleted.",
  }, null, 2));
} catch (error) {
  console.error(`Mock catalog audit failed (${error?.code || error?.name || "unknown"}). No data was changed.`);
  process.exitCode = 1;
} finally {
  if (connected) await client.end();
}
