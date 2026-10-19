# Grouped material filters

Explicit selections for material, color and origin are now supported too; see
`docs/product-filter-attributes.md`. When present, a product's manual selections
take priority over the text classification described below.

Catalog filters accept `materialGroup` alongside the existing exact `material`
parameter. For example:

```text
/api/catalog/search?materialGroup=inox-304&materialGroup=plastic&brand=HAFELE
```

Groups use OR within the selection and AND with brand, category, search, price
and stock constraints. The regular variant deduplication, pricing and pagination
still apply. Invalid group IDs or more than 13 selections return 400.

`src/catalog/material-groups.ts` assigns navigation tags from the existing
material text. SUS304, SUS 304 and explicit Inox 304 descriptions share one
group. Generic inox stays in `inox-other`; a product combining inox and plastic
can match both groups. Stainless steel is excluded from ordinary steel unless
another steel component is explicitly mentioned. Unknown nonempty descriptions
use `other`; blank descriptions have no material tag.

The query expands selected group IDs to matching raw values from the published
catalog metadata and uses bound SQL parameters. `facets.material` retains its
existing raw-string contract, and old `material=...` URLs remain exact matches.
There is no database rewrite, schema migration or change to product descriptions.

Deploy this backend before the frontend that sends `materialGroup`. The frontend
maintains the same classification rules in its own `lib/material-groups.ts` for
display and preview mode; update the two repositories together.

Start the local QA database with `npm run db:local`, then run:

```sh
npm run test:materials
```

The tests cover aliases, mixed materials, unspecified grades, grouped versus
exact queries, private products, combined filters and pagination. API tests use
a temporary schema on localhost and remove it afterward.
