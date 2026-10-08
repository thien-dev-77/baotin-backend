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

Mutations retain existing HttpOnly JWT cookie authentication, trusted-origin
checks and transaction serialization. No anonymous or B2B management access.
Categories are global website data, not branch-specific.

## Contract

Category fields: `slug`, `name`, `image`, `description`, `subcategories`,
`visible`, `sortOrder`. Admin responses additionally have `revision` and
`productCount`; public responses also carry the current revision.

Create/update body:

```json
{
  "slug": "thiet-bi-phong-tam",
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
- Product count includes public and private products. There is no destructive
  category-delete endpoint; use visibility instead.

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
