# Catalog Performance - 08 October 2026

Verified locally; no production database was changed during implementation.

`LedgerService.stock` now queries only the requested branch/SKUs and reserving
order statuses, selecting inventory numbers and order data without unrelated
warehouse/checkout columns. Queries run concurrently; one reservation map and
one on-hand map replace a full orders/balances scan for each product. Empty
product lists skip database reads. Reservation exclusions, stages, branch fallback,
zero-stock clamping and first-line duplicate semantics remain unchanged.

Catalog product/category/authentication reads run concurrently, and public product
rows select only their data. Personalized pricing still runs per verified customer;
no server cache was introduced for sessions, stock commands or prices in the API.
Frontend caches only sanitized public SSR DTOs and invalidates after successful
mutations through its proxy. Stock/price/credit validation at command time stays
authoritative and does not use the frontend cache.

TypeORM indexes: `orders_branch_idx` on orders.branch;
`inventory_branch_product_idx` on inventory_balances(branch, productId).
Back up production and review these on staging before approved synchronization.
If synchronization is off, deploy code without assuming the indexes exist until
the database change has been explicitly applied. No reseeding is needed.

```sh
npm run build
npm run typecheck
npm test
npm run test:operations
npm run test:products
npm run test:categories
```

Operations integration tests compare optimized stock against full-history results
for all products and one SKU, with excluded orders and other-branch reservations.
They also cover parallel confirmation, releasing reservations, single warehouse
issue, customer price isolation, credit/receipt reversals and schema upgrades.
All API tests refuse a non-local PostgreSQL database and use disposable schemas.

Remaining: production query/connection timings, composite/expression indexing for
very large active-order workloads, API pagination and cross-service cache
invalidation. Do not globally cache customer prices or return old stock for writes.
