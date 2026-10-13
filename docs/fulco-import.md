# Fulco catalog import - 13 October 2026

Only the first sheet, `Bảng Báo Giá Chi Tiết`, in
`Bang_Bao_Gia_Fulco_Bao_Tin_Moi_Nhat.xlsx` is read. The second/third sheets and
the summary row are ignored. ExcelJS reads text, merged cells and hyperlinks;
input prices must be numeric. Output formulas are ignored and prices are
recomputed from list price. `0.6` in Excel means `60%`, not `0.6%`.

## Imported Data

The Supabase `baotin_app` schema contains 242 private products, 28 hidden
categories and 41 variant groups. User-selected configuration is CK from
the workbook for both B2C and B2B, all products private:

- 235 SKU use 60% B2C and 60% B2B; 7 use 65% for both.
- 223 products have stored images; 19 source rows have no gallery/name.
- Stock is zero because the workbook contains no inventory quantities.
- 527 distinct converted images were uploaded to the deployed backend.
- 8 source images were not converted: 1 exceeds 50 MB and 7 contain JPEG
  decoding errors. Other gallery images were retained; exact URLs and affected
  SKU are in the local import report.

Report and resumable media cache are under
`backups/fulco-import/7fac18e393bf97ef/`, ignored in Git. The final report is
`511e312e7768f247-report.json`. It contains parsed rows, warnings, local image
paths and prepared product/category records. It contains no JWT or credentials.
The `fulco-catalog-import` audit stores the workbook/options hash and created
product IDs. Repeating the same completed import does not duplicate records.

## Mapping

| Workbook field | Product data |
| --- | --- |
| Original SKU | `code`; identity for orders and inventory |
| New SKU | `alternateCode`; retained and searchable |
| Group | Category name, generated slug |
| Name | `name`; missing source names use `Fulco <SKU>` and remain private |
| Source product link | `sourceUrl` |
| Gallery URLs | Download, validate, convert to WebP, store `/media/uploads/...` |
| Short content | `shortDescription` |
| Product information + packaging description | `description`, without duplicate text |
| Full specifications | `technicalDetails`; original multiline content preserved |
| Usage instructions | `usageGuide` |
| Unit | `unit` |
| Cabinet size | `size`; numeric millimeters gain `mm` |
| List price | `listPrice` |
| Discount | `b2cDiscount`, `b2bDiscount` as selected |

`specification` is a compact summary capped at 500 characters. Full original
specifications are in `technicalDetails`, so the summary cap does not lose
source information. Material/color/warranty are extracted only from labeled
source content; unknown origin remains blank. Warranty is no longer a fixed
24-month value in the frontend.

Variant grouping uses source URL, category and normalized product name. Unique
size/color combinations become dimensions; ambiguous combinations receive a
SKU-based `Phiên bản` attribute. Groups are validated with the same rules as
admin variants. This avoids treating unrelated items with the same display name
as interchangeable variants. Each SKU has independent prices, gallery and stock.

## Operator Commands

Run from the backend repo. Preview creates a local report without contacting
the database or downloading images:

```sh
npm run import:fulco -- --file ../excel/Bang_Bao_Gia_Fulco_Bao_Tin_Moi_Nhat.xlsx --discount-target both
```

Apply using the configured database and deployed backend:

```sh
npm run import:fulco -- --file ../excel/Bang_Bao_Gia_Fulco_Bao_Tin_Moi_Nhat.xlsx --discount-target both --apply --remote-api https://baotin-api.devops-testing.site --origin https://baotin-b2b.devops-testing.site
```

Private is the default. `--discount-target b2b --b2c-discount 0` applies the
workbook rate to B2B only. `--publish-valid` explicitly publishes eligible
products; it was not used for this import. Existing SKU/slugs/categories are
never overwritten. Product/category inserts and audit are one transaction;
initial revisions are set explicitly. An operator session using an existing
active admin/boss is created for authenticated media uploads and removed in
`finally`; JWTs are never written to reports.

Images are downloaded only from HTTPS `fulco.vn/static/media/`, without following
redirects. Requests have time/size/pixel limits and image bytes are validated.
Media uploads are throttled and recorded in a resumable manifest. Source URLs
and identical converted content are deduplicated. Download/upload failures can
be retried before commit. An interrupted upload may leave unused media files,
but does not create a partially imported catalog.

## Media Across Redeployments

The successfully stored media also lives in `media/imported/fulco/` (about 60 MB)
with the same filenames as the backend uploads. These imported catalog assets
are included in build output by `copy-runtime-assets.mjs` and served at the
existing `/media/uploads/` paths. Product/category/content validation checks
this fallback when a runtime upload file is absent. Other admin uploads still
need persistent storage and backups; the build never copies private runtime
`media/uploads/` files.

Deploy backend before frontend. Backend adds optional source-content DTO fields,
gallery limit 20 and the bulk endpoint; frontend then preserves these fields
when editing imported items. Upload API still accepts at most 10 files per
request. Hidden categories must be shown separately after reviewing products.

## Bulk Product API

`POST /api/admin/products/bulk`, admin/boss/sales only. Max 500 explicit SKU IDs
with revisions. Actions: `publish`, `private`, `discounts`.

`GET /api/admin/products/selection?branch=...&q=...&category=...&status=...`
uses the same product filters and returns only `id`, `code`, `revision` for up
to 500 results. It performs one compact query, without gallery, full JSONB
product content, stock ledger or `/admin/state`. Only product managers can use it.

```json
{
  "action": "discounts",
  "products": [{ "id": "PRODUCT_ID", "revision": 1 }],
  "b2cDiscount": 60,
  "b2bDiscount": 65
}
```

Either discount may be omitted to keep its current value. Products must already
have configured list/B2C/B2B pricing. Price policies retain priority. The API
rejects stale revisions, duplicate/missing IDs, empty/invalid discounts and
incomplete publication. All selected products are validated before writes;
one invalid product aborts the transaction. Response includes updated revisions
and hidden category names when publishing. Bulk actions do not change category
visibility or unselected variants and do not recalculate existing order snapshots.

## Verification

```sh
npm run test:fulco
npm run test:product-bulk
npm test
```

Tests use disposable PostgreSQL and mocked image responses, never Supabase.
