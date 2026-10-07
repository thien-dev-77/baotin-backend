# Product Management - 07 October 2026

## API

All paths use the `/api` prefix and authenticated JWT cookies. Writes require
an allowed Origin and `X-BaoTin-Client: web`, as with existing endpoints.
Only admin, boss and sales can create/edit products or upload images.
Warehouse, accountant, B2B and anonymous users cannot write products.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/admin/state` | Products include `published` and `revision`; response also includes categories |
| POST | `/admin/products` | Create a product; returns `{ id, product }`, status 201 |
| PATCH | `/admin/products/:id` | Replace editable fields; current `revision` required; returns `{ id, product }` |
| POST | `/media/product-images` | Multipart `images`, 1-10 files; returns `{ urls: string[] }` |

Product fields: `name`, `code`, `slug`, `category`, `subcategory`, `brand`,
`unit`, `price`, optional `oldPrice`, `specification`, `material`, `color`,
`size`, `origin`, `description`, `gallery`, `featured`, `published`.
Unknown properties, client stock/customer prices and invalid numbers are rejected.
`description` is plain text, not HTML; storefront renders it escaped.
Category must exist; optional subcategory must belong to it.
SKU uniqueness is case-insensitive after trimming; slugs are unique URL-safe
lowercase strings. Omitted `oldPrice` clears the previous value on update.
Old price cannot be below retail price.

Existing product IDs are stable. A new product starts with zero stock.
Stock changes belong to `/admin/ledger`, not the content editor. Code/unit
changes are blocked after orders, stock records or Kiot mappings use a product.
Stale revisions return 409 and never overwrite a more recent change.
Successful content writes create audit events, without logging secrets.

## Images

JPEG, PNG and WebP only; maximum 5 MB per file and 10 gallery entries.
Sharp validates actual image bytes, auto-rotates, limits decoding to 20M
pixels, resizes inside 2000x2000 and stores WebP in `MEDIA_DIR/uploads`.
Every image in a batch is validated before any files are written.
On write failure, newly written batch files are removed.

Upload returns backend-relative URLs without changing a product. Saving the
form persists its gallery atomically with other content. Gallery order is
display order; the first entry becomes `image` (cover). Removal from gallery
does NOT delete the underlying file, which may be shared or referenced elsewhere.
Unattached uploads from abandoned forms are retained; orphan cleanup is not
automated. Back up the persistent media volume alongside the database.

Only existing local image paths are accepted. External URLs and traversal
paths cannot be submitted as gallery images. The legacy single-image route
`/media/products/:id/image` remains available for existing callers.

## Visibility

Frontend defaults new products to private (`published: false`). Private products
can be managed by staff but are absent from the public catalog, search/category
lists, related products and guest/B2B product endpoints (404). Order quoting
and checkout cannot accept a private product.

Public products require name, code, category, brand, unit, specification,
positive retail price and at least one valid image. The legacy publish command
also applies the completeness check. Private products can omit images/specs
and use zero price while content is being prepared.

Private is CATALOG visibility, not encrypted or authenticated file storage.
Media URLs remain public when their exact path is known. Confidential files
would require a separate protected-media design.

No new tables or columns are needed: content uses product JSONB, existing
`published` and `revision` columns. No new migration is required.

## Verification

`npm run test:products` builds and starts an isolated API on 127.0.0.1:4004,
uses a random schema ONLY on `.env.local` PostgreSQL 127.0.0.1, and stores
images in a temporary directory. Both schema and media are cleaned afterward.
Tests cover permissions, private visibility/quoting, validation, duplicates,
batch safety, gallery persistence, revisions, stock identity and audit events.
Never point this test at Supabase.
