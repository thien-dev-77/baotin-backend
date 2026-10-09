# Admin Resource Loading - 08 October 2026

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
Individual resource lists remain unpaginated; very large datasets still need
server pagination and dashboard aggregates. The legacy full-state endpoint
remains intentionally broad for compatibility.
