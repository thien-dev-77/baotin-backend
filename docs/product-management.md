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
| GET | `/admin/products/:id/variants` | Fresh group snapshot with every SKU's current revision, including private SKUs; accepts any member ID |
| PATCH | `/admin/products/:id/variants` | Configure all attributes of a group; `id` is the root SKU |
| POST | `/admin/products/:id/copy-to-variants` | Copy selected saved content to chosen sibling SKUs atomically |
| POST | `/admin/products/:id/detach-variant` | Detach one SKU without deleting the product; reanchor remaining SKUs when necessary |
| POST | `/media/product-images` | Multipart `images`, 1-10 files; returns `{ urls: string[] }` |

Product fields: `name`, `code`, `slug`, `category`, `subcategory`, `brand`,
`unit`, legacy `price`/optional `oldPrice`, or configured `listPrice`,
`b2cDiscount`, `b2bDiscount`, `specification`, `material`, `color`,
`size`, `origin`, `description`, `gallery`, `featured`, `published`.
Optional `variantGroupId` and `variantAttributes: [{ name, value }]` group
multiple independent SKUs. For a new group, send `variantGroupId: "self"` with
1-6 attributes. The server replaces `self` with the new product UUID. For a
child SKU, send that UUID as `variantGroupId` and the same ordered attribute
names with different values. Each SKU still has its own code, slug, price,
gallery, stock, publication state, Kiot mapping and order identity. Product
groups live in JSONB; no TypeORM migration is required.

Optional `variantLabel` sets a display label for an individual SKU (maximum
100 characters, trimmed plain text). Empty labels display the SKU's `code`.
Send an empty string to clear a saved label; omitting it on update preserves
the previous label. Public product and variant responses include this field.
Labels do not affect attribute combinations, SKU uniqueness or order identity.

Group configuration accepts `{ products: [{ id, revision, attributes: [{ name,
value }] }] }` for every SKU in the group, including private ones (maximum 500
SKUs per request). The same ordered names must appear on each SKU, with 0-6
attributes and nonempty values for retained types. This endpoint can add, rename or remove types,
or initialize a group on a standalone product. It validates all rows and
updates them atomically; incomplete membership, stale revisions or newly introduced
duplicate combinations return 409. Removing types while preserving their remaining
values may make multiple SKUs share a combination; this is allowed across the entire
group. Existing overlaps remain valid on later content edits or type renames. An empty
attribute array removes all types while keeping group membership and every SKU.
Invalid schemas return 400. Codes, pricing, inventory,
images and custom SKU labels are preserved; size/color facets follow their
corresponding attributes. Successful changes create a group audit event.
Duplicate-combination errors include every conflicting combination in the
submitted group, listing the SKU codes and each attribute name/value with
instructions to correct values, add a distinguishing type or detach a SKU.
The request remains atomic; no SKU changes when validation fails.

The server rejects new duplicate combinations (case insensitive), repeated
attribute names, missing group roots, inconsistent category/brand/unit, or
changing group identity. Groups with no types distinguish new members by their
unique SKU and slug. Type changes go through the group endpoint; individual product
edits retain the group's ordered schema. `Kích thước...`/`Size` and `Màu sắc`/`Color` attributes also
set the existing `size`/`color` catalog facets. A child may be private while
other SKUs in the group stay public. Order quotes and price policies continue
to use the exact child `productId`; existing order snapshots are unchanged.
The storefront offers a SKU chooser for matching combinations, or for the whole
group when all types have been removed. Deploy that chooser before enabling the
backend's type-removal behavior. Run `npm run test:variant-groups` for the isolated
PostgreSQL regression covering group-wide removal, shared values, empty schemas,
SKU edits, publication and inventory preservation.

Detaching accepts `{ groupId, products: [{ id, revision }] }`, with the complete
fresh group membership (including private SKUs), at least two and at most 500
unique members. The URL identifies the SKU to detach. The transaction locks the
anchor and members, checks every revision, then moves the SKU into an isolated
group whose ID is its own ID. Attributes and custom labels are preserved along
with all identity, content, prices, inventory, publication and order references.
If the old anchor is detached, the earliest remaining SKU (createdAt, then ID)
becomes the new anchor for every remaining member. A pair can become two isolated
groups. Conflicting membership/revisions return 409 with no partial changes;
malformed snapshots return 400 and a missing anchor returns 404. Only admin,
boss and sales can detach. Each success records `product-variant-detach` with
old/new group IDs and changed revisions. Product edits and content copying use
the same anchor-first lock order so concurrent writes cannot restore old links.
The frontend mutation proxy invalidates all public catalog/detail caches.
No database migration is needed. Deploy the backend before the frontend action.

Content copying accepts `{ revision, fields, products: [{ id, revision }] }`.
The URL identifies any saved source SKU, including a child; recipients must
belong to the same group and exclude the source. Select 1-500 unique recipients
and at least one of `name`, `shortDescription`, `description`, `technicalDetails`,
`usageGuide`, `warranty`, `gallery`, `material`, `origin`. Only selected fields
are copied from the database; request-supplied content and unknown fields are
rejected. Technical details also copy the listing `specification`; gallery
copies the cover `image` and verifies source image files. Empty selected fields
clear their recipient values. SKU, slug, stock, prices/discounts, publication,
variant attributes and custom labels are preserved. Source revision is not
changed. Missing records return 404, group/field/publication violations 400,
and stale source/recipient revisions 409. All recipients validate before saving;
one invalid public SKU rolls back the request. Successful requests create one
`product-variant-content-copy` audit event with source revision, fields and
updated recipient IDs/revisions. No schema migration is needed. Deploy this
backend before enabling the frontend action. Run `npm run test:variant-copy`.

`GET /catalog/product/:slug` embeds a `variants` array for grouped products.
It includes only public SKUs and retail data, with no guest B2B prices.
Authenticated B2B clients request `/catalog/selection?ids=...` for their actual
policy prices. Public search, bootstrap and `/catalog` show one matching SKU per
group; size/stock/price filters apply to individual SKUs before grouping.
Admin browse and CSV retain every SKU for editing and inventory operations.
Unknown properties, client stock/customer prices and invalid numbers are rejected.
Descriptions can contain CKEditor HTML; the storefront filters HTML before
rendering and retains line breaks for legacy plain text.
Category must exist; optional subcategory must belong to it.
SKU uniqueness is case-insensitive after trimming; slugs are unique URL-safe
lowercase strings. Omitted `oldPrice` clears the previous value on update.
Old price cannot be below retail price. With list/discount pricing, the server
derives both prices; content-only edits preserve legacy prices. See
[pricing contract](product-pricing.md) for policy priority and read privacy.

Existing product IDs are stable. A new product starts with zero stock.
Stock changes belong to `/admin/ledger`, not the content editor. Code/unit
changes are blocked after orders, stock records or Kiot mappings use a product.
Stale revisions return 409 and never overwrite a more recent change.
Successful content writes create audit events, without logging secrets.

## Images

JPEG, PNG and WebP only; maximum 5 MB per file and 10 gallery entries.
Sharp validates actual image bytes, auto-rotates, limits decoding to 20M
pixels, resizes inside 2000x2000 and stores WebP in `MEDIA_DIR/uploads`.
Imported Fulco images are read from `MEDIA_DIR/imported/fulco`, under the same
root. Existing `/media/uploads/<filename>` URLs first check `uploads`, then
`imported/fulco`; validation uses the same order. An explicit `MEDIA_DIR` does
not fall back to the release's bundled imported images. If no media root is set,
the normal source/build `media` directory is used for both paths.
For Hostinger, use a persistent directory outside `hbuilds/current`, for example
`/home/u835023841/domains/baotin-api.devops-testing.site/baotin-media`, with
`uploads`, `imported/fulco` and `images` directly inside. Copy the old media
contents before restarting; no product URLs or database paths need changing.
After restart, `Bao Tin media root: ...` in the API log identifies the root in use.
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
