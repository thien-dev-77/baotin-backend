# Category Management

Implemented UI and API; not deployed to production by this change.

## Routes And Permissions

| Route | Access | Result |
| --- | --- | --- |
| GET /api/categories | Public | `{ items: Category[] }`, visible only, ordered |
| GET /api/categories/:slug | Public | Visible category; missing/hidden returns 404 |
| GET /api/admin/categories | Admin, boss, Sales, accountant | All categories, including hidden; product counts |
| POST /api/admin/categories | Admin, boss | Create category |
| PATCH /api/admin/categories/:slug | Admin, boss | Edit category with required revision |
| POST /api/admin/categories/bulk | Admin, boss | Show/hide selected categories atomically |

Mutations retain existing HttpOnly JWT cookie authentication, trusted-origin
checks and transaction serialization. No anonymous or B2B management access.
Categories are global website data, not branch-specific.

## Contract

Category fields: `slug`, `name`, `parentSlug`, `image`, `description`, `subcategories`,
`visible`, `sortOrder`. Admin responses additionally have `revision` and
`productCount`; public responses also carry the current revision.

Create/update body:

```json
{
  "slug": "thiet-bi-phong-tam",
  "parentSlug": "",
  "name": "Thiet bi phong tam",
  "image": "/media/uploads/UPLOAD-UUID.webp",
  "description": "Thiet bi va phu kien phong tam",
  "subcategories": ["Voi nuoc", "Phu kien phong tam"],
  "visible": true,
  "sortOrder": 80
}
```

For PATCH, also supply the current positive integer `revision`. A successful
update always advances it, including an identical save. A stale revision returns
409 without changing the row. A PATCH without a revision returns 400.

- Slug is a unique ASCII kebab-case identifier, maximum 80 characters, immutable
  after creation. Existing product/category URLs are not rewritten.
- Names are trimmed and NFC-normalized; duplicate names ignore Vietnamese case.
- Groups are trimmed strings, maximum 50 groups and 100 characters per group;
  blank or case-insensitive duplicate names are rejected.
- Removing/renaming any group used by a product is blocked with 409. Move those
  products to another group first, including private products.
- Position is an integer from 0 to 100000; smaller positions display first,
  ties use slug ordering.
- Visible categories require an existing backend image. Upload through existing
  POST /api/media/product-images with one `images` file: JPEG/PNG/WebP, 5 MB max.
  Uploads are converted to WebP and served from the backend media directory.
- HTTP/external paths, traversal and nonexistent image files are rejected.
- Product count includes public and private products in the entire subtree. There is no destructive
  category-delete endpoint; use visibility instead.

## Parent And Child Categories

`parentSlug=""` or an absent value creates a root. A nonempty value references
another saved category by its immutable slug. PATCH without this field retains
the current parent; sending an empty string moves the branch to the root.
The entire resulting tree is validated inside the serialized transaction.
Missing parents, self-parenting, indirect cycles and more than four levels
return 400 without changing any category. Reparenting checks descendant depth.

`subcategories` remains the legacy list of product-group filter labels; it is
not the category tree. Actual child categories are separate records with their
own slug, cover, visibility and revision. Products keep a single `category` slug.
No relational schema change is required: `parentSlug` is stored in existing JSONB.

Public navigation excludes descendants of hidden ancestors without rewriting
their own visibility or product publication. Public child routes return 404
when any ancestor is hidden. Catalog search expands a selected visible parent
to its visible descendant slugs; direct published product URLs remain available.
Admin browse and bulk product selection expand parents across all descendants,
including hidden categories. Category counts include the entire subtree.
Homepage selection remains bounded at five distinct variant groups per root,
with at most five category sections and 55 hydrated showcase/category products.

See [Fulco normalization](fulco-category-normalization.md) for the reference
tree, safe maintenance command and actual data update.

## Bulk Visibility

```json
{
  "action": "show",
  "categories": [
    { "slug": "phu-kien-bep", "revision": 2 },
    { "slug": "phu-kien-tu-ao", "revision": 3 }
  ]
}
```

`action` is `show` or `hide`. Supply 1-500 unique category slugs with positive
integer revisions. The response is `{ updated, visible, categories }`; each
category contains `slug`, its new `revision` and `visible`.
All selections are validated in the serialized transaction before writing.
Missing categories return 404; stale revisions return 409. Showing a category
without a valid backend cover image returns 400 and identifies affected names.
Any failure leaves every selected category unchanged. Hiding is allowed even
when covers are missing. One audit event records the batch and new revisions.
Names, images, descriptions, groups, ordering and all products remain unchanged.
No schema changes or automatic publication of imported private products.

## Visibility

`visible=false` removes the category from the public category list, header,
dropdown, mobile navigation, home sidebar, home category grid and category
search/filter suggestions. Its category route returns 404.

It does NOT change product publication, stock, order snapshots, prices or Kiot
links. A published product may still be found via search and its own URL. To hide
a product itself, set that product to private. The product breadcrumb omits a
missing/hidden category instead of linking to a broken route.

GET /api/catalog exposes only visible categories, but continues to return all
published products. GET /api/admin/state exposes all categories for product
editors, Sales product selection and CMS category selection.

## Storage And Rollout

`categories` keeps its existing `slug` key and JSONB data, plus a version column
`revision` with default 1. Legacy JSON rows without visibility/position remain
visible and retain the original eight-category order using compatibility
defaults. Saved metadata overrides those defaults. No seed overwrites existing
categories and no frontend `shared/` folder is needed.

Back up the database before applying schema changes. With the project's existing
`DB_SYNCHRONIZE=true` setup, redeploying the backend adds the revision column.
If synchronization is disabled, add the same column explicitly before using
these endpoints. Verify existing categories and products before enabling writes.
Deploy backend before frontend; older backend deployments lack the new routes.
Keep backend `MEDIA_DIR` on persistent storage; frontend does not own uploads.
Cancelled forms can leave unreferenced uploads, as with existing product uploads;
do not delete a file until all product/content/category references are checked.

## Verification

`npm run test:categories` runs against PostgreSQL at 127.0.0.1 only, creates a
random isolated schema and temporary media directory, and cleans both up.
It covers permissions, legacy defaults, duplicate names/slugs, malformed data,
uploads, visibility/order, product creation, used-group protection, optimistic
concurrency and audit events. `npm run test:products` covers product regressions.

Local QA is not a production database acceptance test or deployment.
