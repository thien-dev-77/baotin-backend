# HAFELE catalog import

The HAFELE importer reads the first sheet of the 20-column price workbook. It
does not use the Fulco importer or modify existing products/categories. Source
workbooks and image files are never rewritten.

## Data mapping

- Read headers from row 4, skip title/total rows, and inherit only actual merged
  cells. Column C remains a string, including dots and leading zeroes.
- Set brand `HAFELE`. D/MasterSKU is retained in the import report as source
  metadata; it does not replace the product code or automatically join groups.
- Split B on `|` into parent/child categories. Match normalized names under the
  resolved parent, and reuse established aliases for kitchen appliances,
  sinks/taps, furniture hardware and their existing matching children. Never
  rename/move reused categories. New categories are hidden and use Vietnamese
  sentence case: only the first character is uppercase, the remainder lowercase.
- Keep gallery paths and their order exactly as supplied; the first image is
  the cover. Verify every distinct URL with HEAD on the target HTTPS API.
  There is no download, conversion, upload or media deletion.
- Preserve H/I/J/K/L content. Append N/O as labeled technical details. Source
  N must contain cabinet measurements; the corrected workbook moved installation
  styles/product dimensions to their appropriate content fields.
- Map P to list price, Q to B2C and S to B2B. Ignore R/T formulas and cached
  results; derive prices using normal server pricing rules. Fractional VND are
  rounded to the nearest dong and recorded in warnings. Empty P becomes zero
  in a private draft, explicitly reported as missing source price.
- Every new SKU is private, not featured, has zero initial stock and displays
  the authenticity label by default. The importer does not publish products,
  change stock ledgers, alter prices on existing products or rewrite orders.

## Duplicate SKUs and variants

Repeated SKU rows must agree on name, unit, price/discounts, gallery, source URL,
measurements and source content. Otherwise import stops. Matching repeated rows
are merged into one SKU, preserving distinct packaging descriptions, source rows
and classification paths in the report. The product uses their deepest common
category because the current model has one primary category per SKU.

Only explicit merged-STT families create variant groups. Candidate dimensions
are cabinet size, labeled capacity, per-SKU color, direction and physical
dimensions. Select only dimensions needed to distinguish members. All members
must share category/brand/unit and pass the regular variant validator. Ambiguous
combinations stop import; no guessed values or SKU-based fallback are added.

## Commands

From `backend`, preview reads the configured database without writing it and
saves a report under ignored `backups/hafele-import/<workbook-hash>/`:

```sh
npm run import:hafele -- --file ../excel/Bang_Bao_Gia_Hafele_Bao_Tin_Chi_Tiet.xlsx
```

Apply the preview rules, verify server media and commit:

```sh
npm run import:hafele -- --file ../excel/Bang_Bao_Gia_Hafele_Bao_Tin_Chi_Tiet.xlsx --apply --media-base https://baotin-api.devops-testing.site
```

An optional `--media-check PATH` accepts a HEAD verification report no older than
one hour, for the same origin and every required image path. Reports contain
only paths/status/content types/timestamps, never credentials.

The commit takes a transaction lock, rechecks the catalog checksum, rejects
existing SKU/slug conflicts, writes the exact pre-import catalog backup, then
inserts new categories/products. Existing data is compared again before commit.
Any error rolls back all inserts. Audit metadata records the source hash,
created IDs, backup/report paths and verification summary. Repeating the same
completed workbook is a read-only no-op; a changed workbook cannot overwrite
already imported SKUs.

## Application compatibility

Backend and frontend gallery limits are increased together from 20 to 30 to
retain the three 26/27-image HAFELE galleries. Deploy both updated applications
before editing these galleries in the deployed admin; older backends still
enforce 20 images when saving, although they can read the imported galleries.

Category names are unique within their parent, while category slugs stay
globally unique. This supports the source's repeated leaf names under separate
KOSMO-C/KOSMO-P/OVAN branches. Deploy the backend change before editing these
same-named categories through admin. Existing category rows remain unchanged.

## Category name normalization — 19 October 2026

The 67 categories created by the completed HAFELE import were subsequently
renamed to sentence case at the user's request. Slugs, parent relationships,
visibility, images and product assignments remain unchanged. All 730 product
rows (including 242 Fulco) and the 44 reused/pre-existing categories were
verified unchanged. Only the selected category names and revisions changed.

The normalization command discovers ownership from `hafele-catalog-import`
audit records, backs up the locked catalog, updates those names only and checks
all other fields before committing. It is a no-op when names already match:

```sh
npm run catalog:normalize-hafele-names
npm run catalog:normalize-hafele-names -- --apply
```

Backups, preview, result and independent verification are under the ignored
`backups/hafele-category-names/` directory. Future HAFELE imports use the same
formatter, so uppercase source category labels do not reappear.

## Completed import — 19 October 2026

Source SHA-256:
`e1d4df9729894e4aeb1e97affc1c867323591e392e421433573851a20e9a0eac`.

- 491 source rows → 488 private HAFELE SKUs; 28 groups containing 99 variant SKUs.
- 67 new hidden categories and 10 existing categories reused.
- 1,716 existing server images verified and preserved, including all galleries
  above 20 images. 67 products have no source gallery.
- Seven fractional list prices rounded; five products await source prices.
- 242 existing Fulco products and all 44 existing categories verified unchanged.
- The deployed admin API verified 488 HAFELE results and all six OMERO variants.

The ignored source/plan/warning report is
`backups/hafele-import/e1d4df9729894e4a/report.json`. The same directory contains
the exact locked pre-import backup and independent DB/API verification reports.

## Verification

```sh
npm run test:hafele
node --test test/fulco-import.test.mjs
node --import tsx --test test/category-tree.test.ts test/product-pricing.test.ts
```

Import tests use disposable PostgreSQL and mock media responses. They cover
merged cells, pricing, full galleries, category reuse, meaningful variant
attributes, ambiguous input rejection, rollback after an insert failure,
concurrent-preview protection, preservation of existing data and idempotency.
