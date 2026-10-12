# Product Pricing - 12 October 2026

## Write Contract

`POST /api/admin/products` and `PATCH /api/admin/products/:id` accept the
existing content/visibility fields plus:

```json
{
  "listPrice": 100000,
  "b2cDiscount": 20,
  "b2bDiscount": 35
}
```

Supply the three fields together. Amounts are safe whole VND integers between
0 and 999999999999; percentages are 0-99.99 with at most two decimal places.
Backend computes `price=80000`, `oldPrice=100000`, and the default B2B price
`65000` independently from list price. Derived B2B price is not persisted and
`b2bPrice` is rejected as an unknown input field. When B2C discount is zero,
`oldPrice` is omitted. A client-supplied valid `price` cannot override the
calculation. Existing DTO validation still rejects invalid input types/numbers.

Use integer basis points and BigInt multiplication to avoid floating-point
half-VND differences. Round to nearest VND, half up; minimum 1 VND for a
positive list price. Zero remains valid for a private draft, not publication.
Keep authentication, staff roles, Origin/client-header checks, revision conflict
handling, gallery validation and transaction/audit behavior unchanged.

## Policy Priority

For an active B2B customer, select applicable policies using the existing
date/branch/customer/group rules: customer > group > branch default. In the
selected policy, an explicit SKU price wins over its percentage. Policy rates
apply to `listPrice` for configured products; legacy products retain `price`
as their policy basis. Percentages are not stacked with B2C discounts.

If no policy applies, use the product's configured B2B discount. For legacy
products without it, fall back to their original retail price. Inactive B2B
customers and anonymous users receive retail pricing only.

`PricePolicyService`, paginated catalog search/selection and order quoting use
the same helpers in `src/catalog/product-pricing.ts`. Filters/sorts use the
effective customer price, not a stale JSON retail price. Group/customer policies
may produce prices higher or lower than the product default; the API response's
`customerPrice` is authoritative for the active customer.

## Read Privacy

Public catalog bootstrap, search, selection and product-detail responses include
list price, B2C discount and final retail price, but omit `b2bDiscount` and
`customerPrice`. Authenticated active B2B responses include their actual price.
Warehouse product responses from admin reads and ledger omit all list, discount,
old-price and customer-price fields, and retain the existing `price: 0` redaction.
Frontend role checks alone are not sufficient protection.

## Compatibility

Pricing fields live in product JSONB. No migration or automatic seed rewrite is
required. Legacy `{ price, oldPrice }` inputs remain valid. Content-only writes
do not convert or change legacy prices. For an already-configured product, an
old client cannot change derived `price`/`oldPrice` without supplying the new
configuration. Partial pricing configuration is rejected.

Existing order item prices, approved snapshots, totals and receipts are not
recalculated when catalog prices change. New orders and explicit requotes use
the current trusted catalog/policy values.

Kiot `basePrice` imports previously wrote retail `price`. On configured products,
reject an import whose price differs from the derived retail price with 409,
without partially applying its transaction. Update list/discount configuration
in admin first. Legacy Kiot price imports retain their previous behavior; remote
matching price and visibility changes can still apply normally.

Deploy this backend before a frontend submitting the new fields. Existing
applicable seed/default policies remain active and may override product B2B
defaults; do not silently delete them.

## Verification

```sh
npm test
npm run test:products
npm run test:catalog
npm run test:operations
npm run test:admin-resources
```

Pricing unit tests cover independent/fractional rates, rounding, legacy basis,
policy precedence, validation and redaction. Product API tests additionally
cover create/edit, guest/B2B search/selection/detail/quote consistency and
stale revisions. API tests use disposable schemas on localhost PostgreSQL only;
never set their test database to Supabase or another production instance.
