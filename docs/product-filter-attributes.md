# Product filter selections

Products retain the original `material`, `color` and `origin` descriptions.
Optional `materialGroups`, `colorGroups` and `originGroups` arrays hold explicit
filter selections. The vocabulary and aliases are defined in
`src/catalog/product-filter-attributes.ts` (mirrored in the frontend).

- Missing or `null`: infer from the existing description.
- Array: use only the selected values. An empty array deliberately excludes the
  product from this facet, even if its description contains recognizable text.
- Old clients omitting the arrays preserve existing selections. Sending `null`
  explicitly restores automatic inference.

Public search supports repeated `materialGroup`, `colorGroup` and `originGroup`
parameters. Values within a facet use OR; different facets and existing catalog
constraints use AND. Filtering still occurs before variant deduplication and
pagination. Explicit selections override aliases in SQL, including empty arrays.
Only effective groups from published products appear in the new metadata fields
`facets.materialGroup`, `facets.colorGroup`, `facets.originGroup`.
The old exact `material`, `color`, `origin` parameters and metadata remain valid.

Copying material or origin content to sibling SKUs copies its filter selections
as well. Variant color remains part of the SKU's identity and is not copied;
the administrator can independently classify its color for public filtering.
An origin is never inferred from the product brand. A labeled manufacturing
country takes priority over a preceding design/brand country in the origin text.

Deploy the backend before the frontend. No schema migration is required: these
are optional keys in the existing product JSONB data. Existing products work
without running the synchronization command.

## Populate existing products

```sh
npm run catalog:sync-filters
node scripts/sync-product-filter-attributes.mjs --apply --expected-checksum PREVIEW_CHECKSUM
```

The first command previews all products, across brands and visibility states.
The apply command requires the unchanged preview checksum, saves a new private
backup, and fills only missing/null selections with nonempty descriptions.
Existing manual arrays and empty descriptions are left untouched. It checks the
full catalog before committing: only these group fields and affected product
revisions may change. Categories, descriptions, images, pricing, stock, variant
relationships and publication remain unchanged. All writes and the audit event
share one transaction. Repeating the command is a no-op. Files in
`backups/product-filter-attributes/` are ignored by Git.

```sh
npm run db:local
npm run test:product-filters
npm run test:variant-copy
```

The integration tests explicitly refuse a non-local database. They cover alias
fallback, manual overrides, clearing/resetting, old clients, metadata visibility,
combined filters, persistence, backup verification, stale preview rejection,
idempotence, and rollback after an injected audit failure.
