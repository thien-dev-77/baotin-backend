# Admin product brand filter

`GET /api/admin/browse?resource=products&branch=Quy%20Nh%C6%A1n&brand=HAFELE`
accepts an optional `brand` string up to 80 characters. Matching is exact,
case-insensitive and NFC-normalized, with surrounding whitespace trimmed.
Omitting `brand` includes every brand. It combines with keyword search,
category descendants, legacy subcategory and publication status.

Product browse responses include `brands: string[]`, read from all product
rows, including private products. Choices are deduplicated without regard to
case and remain available when a search/filter returns no rows. This is one
compact grouped SQL query; no full catalog is returned to populate the filter.

Both pagination/count and `GET /api/admin/products/selection` use the same SQL
filter. Warehouse redaction and branch/staff authorization remain in effect.

The frontend keeps `brand` in the URL, resets pagination and bulk selection
when it changes, and retains it when paging, returning from the editor, selecting
all matching products or exporting CSV. CSV export shares the same filter
allowlist as the browse query, including subcategory. Clearing filters removes
brand as well. Preview mode filters the local catalog with the same semantics.

Verification covers private SKUs, mixed-case labels, full-catalog choices,
unknown brands, query validation, SQL parameter binding, combinations of
filters, last-page clamping, filtered bulk selection and desktop/mobile CSV.

Deploy the backend before the frontend; older APIs do not accept the new
`brand` query parameter or return its choices.
