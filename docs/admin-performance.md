# Admin Resource Loading - 12 October 2026

## Admin read optimization — 20 October 2026

Deploy the backend before the frontend; this release adds read endpoints. No
schema migration, seed, upload relocation or production data rewrite is needed.
Legacy endpoints retain their previous response contracts.

- Staff authentication joins the session and current user in one SQL query.
  Session revocation/expiry, disabled accounts and current role/branch grants
  remain live; authentication and financial values are not cached server-side.
- `GET /api/admin/product-metadata?branch=...` returns categories and brands.
  A database fingerprint detects changed category data/revisions and brand values
  across processes/imports; unchanged metadata reuses the server projection.
  The frontend privately caches this response separately from page results.
- Product list clients send `metadata=false` to `/api/admin/browse`. Omission
  preserves the legacy metadata response. Product pages and editor group reads
  start independently of category dictionaries. Editor reads use the existing
  access-scoped cache; explicit refresh/save invalidates subscribed reads.
- `GET /api/admin/order-editor?branch=...&id=...` requires admin/boss/sales.
  Omit `id` for creation. It returns branch customers, categories and only the
  selected order's related records/SKUs, with long product content omitted.
  The product picker requests published SKUs in pages of 10, debounces search,
  and retains selected SKU records while changing pages. Quotes and commands
  still validate live prices, stock, credit and revisions on the server.
  A refreshed order revision blocks saving the old draft; reloading explicitly
  uses the existing unsaved-change confirmation.
- `GET /api/admin/ledger/page?branch=...&tab=stock|credit|entries&page=1&pageSize=10&q=...`
  returns only the active tab with pagination. Allowed sizes: 10/25/50. Stock
  projects ID/code/name/unit/stock and calculates on-hand/reserved/available for
  that page. Customer finance is calculated for paged customers; receipt/order
  reads project only finance fields. Warehouse access excludes credit and
  filters history to stock entries. Adjustments retain balance/branch guards.
- Reports issue three independent reads: customer finance, period-only order
  fields, and all-time unpaid credit rows joined to posted receipts. Aging keeps
  opening balances, old orders and unknown due dates. Maps replace repeated
  customer/order/receipt scans. Detail dependencies and warehouse counts overlap;
  count/page reads run in parallel and still clamp out-of-range pages.
- CKEditor initializes within 200 px of the viewport, or on explicit activation.
  Parent form state preserves unmounted editor values; activated editors stay
  mounted across tab switches. Refresh errors preserve editable draft content.

Read-only service measurements on 730 current products / 111 categories:

| Read | Before | After |
| --- | ---: | ---: |
| Product page, 10 SKUs | 38.5 KiB | 7.7 KiB + separately cached 30.9 KiB metadata |
| New order initial JSON | 2005.7 KiB | 32.5 KiB |
| Ledger initial JSON | 1980.3 KiB / 730 SKUs | 1.7 KiB / 10 SKUs |
| Report resource SQL reads, excluding auth | 7 | 3 |
| Staff auth SQL reads | 2 | 1 |

Measurements used an explicit READ ONLY transaction and rolled back; only
aggregate counts/sizes were saved. One pinned connection serialized parallel
queries, so these are payload/query comparisons, not production HTTP latency
claims. The current measured branch had no orders. Disposable tests add history,
reservations, partial/pending/voided receipts, opening debt, negative balances,
and old credit orders to verify finance. Pool size and transaction locks remain
unchanged. Current EXPLAIN results did not justify adding speculative indexes.

Validation: `npm run test:admin-performance` in each repository; backend build,
admin-resources/operations integration tests on disposable PostgreSQL; frontend
build/typecheck/lint plus admin loading, filters, cache, editor content and SKU
linking regressions. Legacy resource endpoints remain available for other screens.

## Paged Queries And Dashboard

Deploy this API before the matching frontend. Legacy endpoints are retained.

`GET /api/admin/browse` requires `branch` and `resource` (products, orders,
customers, warehouse, approvals, receipts). Optional filters: `q`, `status`,
`category`, `subcategory`, `group`, `sales`, `pilot`, `from`, `to`. Unknown parameters, invalid
calendar dates, inverted dates and page sizes other than 10/25/50 are rejected.
`page` starts at 1 and is clamped to the last page. SQL applies filtering/counts
and offset/limit before loading JSON rows or financial projections. Response:
`pagination: { resource, total, page, pageSize, totalPages, ids }` plus only needed
rows and reference data. Customer pages include directory/assignees/groups and
whole-branch debt/overdue/over-limit summaries. Warehouse pages include global
active-stage counts. Customers receive at most four recent orders each.

Product pages return a lightweight projection: `description`, `shortDescription`,
`technicalDetails` and `usageGuide` are omitted, and `gallery` is an empty array.
Full editor/resource reads keep these fields. Count and bounded page reads run
in parallel; out-of-range requests still resolve to the last page. Categories
are loaded once per browse request. `category` includes descendant categories;
`subcategory` matches the product group and also applies to bulk selection/export.

Stock reads aggregate only requested SKU reservations in PostgreSQL, returning
per-SKU sums rather than every active order document. They retain branch/status
filtering, excluded-order handling, first-occurrence duplicate-line semantics
and existing stock fallback rules. Inventory is still computed live.

`GET /api/admin/orders/:id?branch=...` returns one authorized order with its
products/customer/approvals/receipts. Warehouse staff only see active warehouse
orders with financial data redacted. Other-branch IDs return 404.

`GET /api/admin/dashboard?branch=...&days=7` computes daily revenue, counts and
finance in SQL; only five recent order rows are hydrated. Charts cover the whole
selected period. Pending queues are all-time. Revenue matches effective approved
price snapshots, website shipping and coupons. No product dictionary is returned.

Quotes load only selected customer/SKUs. `/admin/orders/quote` accepts details with
delivery/payment only, while retaining optional legacy contact fields. Quote
validation does not require a complete recipient yet; `save-order` still requires
and validates all contact fields, expected totals, revision and business guards.

Added composite TypeORM index: orders(branch, createdAt, id). Back up and review
synchronization on staging before applying. No new migration or production seed
is required. Dates refer to stored business dates, not UTC conversion in browsers.

`npm run test:admin-resources` covers page bounds, search, all-time order lookup,
directory/finance consistency, auth/branch boundaries, redaction, targeted details,
dashboard totals and compact pricing inputs on a disposable local schema.
`npm run test:operations` verifies website quotes and transactional finance/stock.
Local sample JSON sizes: full state 84,407 bytes, order page 6,947, product page
8,116, customer page 9,303, dashboard 609. Production networking is not measured by
these tests; measure actual pool/query latency after deployment.

## Legacy Compatibility

The matching frontend no longer calls `/api/admin/state`. Legacy clients may
continue using it; it is not an authentication or API prerequisite.

## Endpoints

`GET /api/admin/resources?branch=...&include=products,categories`

Staff JWT/session authentication and current database branch grants are checked
on each request. `include` accepts a comma-separated selection from:

| Resource | Returned fields |
| --- | --- |
| products | products, stockByBranch for requested branch |
| categories | categories |
| customers | customers, including finance projection |
| orders | orders, warehouse, paymentDueDates |
| approvals | approvals |
| receipts | receipts |

Every response includes `today`. Invalid/unknown query parameters and unauthorized
branches are rejected. Warehouse responses redact financial values and restrict
orders to active warehouse stages. Orders internally read branch approvals to
keep effective approved prices correct, without returning unrequested fields.

`POST /api/admin/commands` accepts optional boolean `returnState`:

- `false`: commit and return `{ id }`, without rebuilding full admin state.
- Omitted or `true`: retain the legacy `{ id, state }` response.

Validation loads server-defined dependencies per action in the command's branch,
never client-selected validation data. Existing transaction locking, permissions,
revision checks, prices, reservations, finance and notifications remain intact.

## Queries And Indexes

Branch predicates are applied in SQL, independent reads overlap and unrelated
resources are not queried. Products/categories require four SQL queries, with
no customer finance, receipts or approvals read. Customer ledger queries are
limited to requested IDs, associated orders, posted receipts and relevant credit
entries; lookup maps replace repeated nested scans.

Added TypeORM indexes: customers.branch, approvals.branch, receipts.branch,
orders.customerId, ledger_entries(kind, resourceId). Existing orders.branch and
inventory branch/product indexes remain. Review synchronization and back up on
staging before applying with `DB_SYNCHRONIZE`; never reseed production.

## Matching Frontend

The frontend keeps a private in-memory cache per access scope and branch for
60 seconds, deduplicates in-flight reads and loads only route dependencies.
No window-focus aggregate refresh remains. Order dialogs load extra dependencies
on demand. Commands request compact responses, invalidate affected cache groups
and refresh them without unmounting existing tables. No auth/session call is
introduced by this workflow; Redux authentication and HttpOnly JWT are unchanged.

## Verification

`npm run test:admin-resources` uses a disposable local PostgreSQL schema to check
SQL query count, branch/role boundaries, financial redaction, query validation,
compact commands, committed targeted reads and legacy compatibility.
Operations/customer/product/catalog regression suites retain business guards.

One local seeded-fixture sample: full state 51,789 bytes/9 ms; dashboard resources
9,706 bytes/3 ms; products/categories 35,303 bytes/3 ms. These HTTP samples are
not measurements of production or a promise about the reported six-second load.

Deploy backend before frontend, then inspect Network for the absence of
`/admin/state` and measure production query/pool/network latency separately.
Main lists/dashboard use the new bounded endpoints. Legacy resource reads remain
unpaginated for editor dictionaries and compatible workflows; dedicated content,
review and consultation endpoints retain their previous contracts.
