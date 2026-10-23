# Update existing HAFELE appliance content

This maintenance command reads `Thiet_Bi_Gia_Dung_Hafele_2022.xlsx` and updates
existing HAFELE products by SKU. It uses the explicitly deduplicated
`SKU Độc Bản (186 SP)` sheet; the catalogue sheet contains repeated combo rows.
Unmatched SKUs are reported and never inserted. Ambiguous database matches,
duplicate source codes, shifted headers, formulas in source text and oversized
content stop the command.

## Field mapping

| Workbook column | Product field |
| --- | --- |
| Tên sản phẩm | `name`, sentence case with model identifiers retained |
| Màu sắc / Hoàn thiện | `color` and the existing standard color filter groups |
| Kích thước sản phẩm | `size`, when populated |
| Kích thước cắt đá / lắp đặt | Dedicated entry in `technicalDetails` |
| Đặc tính sản phẩm / Performance | Full text in `description` and `shortDescription` |
| Thông tin kỹ thuật / Specifications | `technicalDetails`, retaining source values and line breaks |

The compact `specification` summary is regenerated from the same model, color
and dimensions. Empty optional cells retain existing corresponding content.
Repeated dimension lines are consolidated without discarding their values.
The workbook's 2022 prices are not used. No colors are guessed from the brand:
`Tiêu chuẩn` remains the source finish, and named colors use the application's
existing filter inference. Color/finish is also included in technical content
when the optional specification cell is blank, so the existing storefront
fallback specification table can display the new color.

## Run

From the backend repository, preview is read-only:

```sh
npm run catalog:update-hafele-appliances -- --file ../excel/Thiet_Bi_Gia_Dung_Hafele_2022.xlsx
```

Apply the reviewed rules to the configured database:

```sh
npm run catalog:update-hafele-appliances -- --file ../excel/Thiet_Bi_Gia_Dung_Hafele_2022.xlsx --apply
```

The write transaction locks the catalogue, rechecks the preview checksum,
writes and verifies a new backup before updating any row, and checks the
complete catalogue against the expected changes before committing an audit
event. Revisions increase only for changed products. All prices, discounts,
images, galleries, stock, IDs, slugs, categories, visibility, variant relations
and other product fields are preserved. Any error rolls back the transaction.
Repeating the same update is a no-op unless content has subsequently changed.

Plans, results and exact pre-update backups are under ignored
`backups/hafele-appliances-update/<workbook-hash>/`. They are not committed.

## Applied on 23 October 2026

Source SHA-256: `f5b793742d57a385` (prefix).

- 186 source SKUs; 78 matched products updated, including 71 renamed titles.
- 108 unmatched source SKUs reported without creating new products.
- 46 public and 32 private products retain their original visibility.
- 242 Fulco products, 410 other HAFELE products and all 111 categories unchanged.
- Source dimensions updated for 61 products; installation dimensions supplied
  for 54. Blank source specification fields remain intact.

## Verification

```sh
npm run test:hafele-appliances
```

Tests use disposable PostgreSQL and cover exact matching, source parsing,
model casing, blank-cell preservation, protected fields, stale plans,
backup verification, full transaction rollback and idempotency.
