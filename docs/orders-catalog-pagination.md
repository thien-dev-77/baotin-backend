# Order Snapshots And Paginated Catalog - 08 October 2026

Implemented in both repositories. Deploy the matching backend before frontend.
All verification uses localhost or controlled QA responses, not production.

## Historical Order Lines

New website checkout and Sales-created lines persist:

```ts
type OrderLine = {
  productId: string;
  quantity: number;
  unitPrice: number;
  snapshot?: {
    name: string;
    code: string;
    slug: string;
    image: string;
    unit: string;
  };
};
```

The server captures only these five catalog fields inside the order transaction.
Client-supplied snapshots are never trusted. Existing lines retain their original
snapshot through edits, approvals and idempotent retries; newly added lines
capture the product at the time of addition. Removing then re-adding a line in
a later saved revision creates a new line snapshot.

Customer order details, admin line details and authorized PDFs prefer snapshots.
Links and reorder eligibility use current public products. Reorder refreshes
only the order's SKU IDs and uses current prices/available stock, never old
prices or quantities above available stock. Checkout remains authoritative.

Legacy lines without snapshots remain readable using current metadata or an ID
placeholder. They are not backfilled with today's name as invented history.
Order totals and price approvals keep existing behavior. PDFs are not immutable
or tax invoices; snapshot labels do not freeze later authorized order changes.
Snapshot images reference backend paths, not copied binary data. Keep persistent
media/backups and do not delete files referenced by historical orders.

## Catalog Read APIs

All paths below have the /api prefix. Existing JWT, ownership, role/branch,
private/no-store API response and mutation validation rules remain unchanged.

| Endpoint | Purpose |
| --- | --- |
| GET /catalog/bootstrap | Bounded homepage product set, visible categories, global brands/facets |
| GET /catalog/search | Search, filter, stable sort and one page of products |
| GET /catalog/selection | Current published products by repeated ids or exact code |
| GET /catalog/product/:slug | Live product detail/404, including slugs named search/bootstrap/selection |
| GET /catalog | Compatibility and explicit full CSV/PDF export only |

Bootstrap includes at most 55 distinct products: ten defaults, ten featured,
ten discounted and five from each of the first five configured lock groups.
Do not assume this set contains every SKU or brand. Global brands/facets are
queried from published products, independently of the bounded product set.

Search parameters:
- q: up to 200 characters; Vietnamese case/accent-insensitive, all words match.
  Percent, underscore and backslash are literal text, not LIKE wildcards.
- category, brand, material, color, size, origin: repeated parameters, OR within
  a field and AND across fields; up to 30 values per field.
- subcategory: exact value; stock: repeated in/out.
- min/max: inclusive effective-price bounds, integers, min must not exceed max.
- promotion=true: old retail price is greater than current retail price.
- featured=true/false; sort=popular/low/high/new, default popular.
- page: default 1, positive integer up to 1000000.
- pageSize: default 12, range 1-60.

```json
{
  "products": [],
  "total": 0,
  "page": 1,
  "pageSize": 12,
  "totalPages": 1,
  "categories": [],
  "brands": [],
  "facets": { "brand": [], "material": [], "color": [], "size": [], "origin": [] }
}
```

Pages beyond the last clamp to the last page; an empty result has page 1 of 1.
Product ID breaks sort ties. Newest sorts by products.createdAt. Existing
products receive the schema-update timestamp, not reconstructed creation dates.
Selection accepts up to 100 IDs per request; frontend batches larger sets.
No IDs/code returns an empty array, never all products. Missing/private SKUs
are omitted. Bad types, unknown parameters and excessive limits return 400.
The old GET /catalog/:slug remains a compatibility alias for non-reserved slugs.

Active B2B queries use the verified customer's branch, effective price-policy
precedence and available stock after reservations, using the same helpers as
checkout. Guests use retail prices and the default branch. Never sort B2B pages
using cached retail prices or cache personalized DTOs globally.

## Frontend Data Flow

- Search, category, brand, promotion and printable catalog pages request the
  relevant page on the server. Filter/sort/page values stay in the URL.
- Public SSR DTOs have a 15-second tagged cache, no cookies/customer prices.
  Existing successful admin proxy mutations invalidate bootstrap and page caches.
- After authentication, active B2B gets its own uncached page response. Changing
  identity clears private resource data; failed reads expose a retry.
- CommerceProvider keeps a bounded/visited SKU registry, not an entire catalog.
  Cart, favorites, order detail and reorder request current IDs explicitly.
- Product cards render their supplied DTO, including products outside bootstrap.
  Quick-code ordering and debounced autocomplete query the backend directly.
- CSV/print buttons fetch the full compatibility endpoint only when requested.
  Normal catalog browsing uses a 60-row page, not an automatic full export.
- Preview mode intentionally uses fixtures. API mode never restores fixtures
  after an empty or failed API response.

Current query implementation applies text/facet conditions in PostgreSQL,
then ranks lightweight ID/price/stock/date candidates server-side with existing
pricing/reservation helpers. Full gallery/description DTOs load only for the
selected page. This bounds browser payloads; it is not SQL-only LIMIT/count
for all derived stock/price cases. Large candidate sets and global facet reads
still need production profiling and, if necessary, indexed SQL projections.
Admin state, order history and other endpoints are not made paginated by this
release. Real sales ranking and curated recommendations are separate work.

## Deploy And Verify

1. Back up DB and persistent media. Stage on a clone.
2. Review TypeORM addition products.createdAt before synchronization. Snapshot
   data reuses existing order JSONB; no historical reseed/backfill is needed.
3. Deploy backend with npm run build, verify the three new catalog endpoints.
   Apply approved schema changes; disable synchronization afterwards.
4. Deploy frontend with matching API mode and full HTTPS BACKEND_URL.
5. Verify page 2 without JavaScript, URL filters/back navigation, B2B price
   ordering, outside-bootstrap cart/favorites, renamed/private order labels
   and reorder/checkout stock validation.

Backend: npm test, npm run test:catalog, npm run test:operations,
npm run test:products, npm run test:experience.
Frontend: npm run lint, npm run typecheck, npm run test:catalog-api,
QA_BASE_URL=http://127.0.0.1:3010 npm run test:ssr, and test:performance after
NEXT_DIST_DIR=.next-build npm run build. Integration tests use disposable local
schemas; performance QA runs controlled local API/production-build servers.
