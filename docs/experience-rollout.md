# Experience API Rollout - 07 October 2026

Implemented locally: recipient-scoped notifications, B2B frequent products and
price requests, private PDFs, consultation processing, CMS, verified/moderated
reviews, pilot KPIs/aging and optional Kiot read-only polling.
Earlier documents listing these as unimplemented are historical.

## Data And Schema

TypeORM adds `notifications`, `content_entries`, `product_reviews` (22 tables
including the previous 19). Leads add branch/status/assignedTo/note/revision.
No shared repo dependency, cross-repo imports or duplicate product catalog.
Seed uses existing `seed/mock.json` and current backend media paths.

- Notifications: recipient UUID, audience role, branch, event key, read time.
  Unique `(userId,eventKey)` protects retries. Reads recheck role and branch.
- CMS: kind, JSON body, publication, revision. Drafts are not public, kind cannot
  change on update. Image must exist on backend disk. Body is plain text.
- Reviews: product/user, text/rating, moderation/revision; one per user/SKU.
- Leads: new/contacted/qualified/closed, branch-eligible assignee, notes/revision.
- Existing approvals/orders/balances/audit/integration tables are reused.

Business mutations and notification insertion share the transaction. Existing
serialization/revision guards remain. No fake historical notifications, purchase
statistics or product reviews are seeded.

## APIs And Access

All paths below have `/api` prefix. JWT cookie, Origin and X-BaoTin-Client guards
remain; never expose backend secrets through NEXT_PUBLIC variables.

| Paths | Access / behavior |
| --- | --- |
| `/notifications` GET, `/notifications/read` PATCH | Own current-role/branch inbox; page size 20, individual/all read |
| `/account/frequently-bought` GET | Active B2B; own issued/completed quantities; published SKU/current price/stock |
| `/account/price-requests` GET/POST | Active B2B; own pending order, revision/reason/SKU prices; existing approvals |
| `/orders/:id/document` GET | Own B2B order or exact guest HttpOnly cookie owner |
| `/admin/orders/:id/document` GET | Admin/boss/sales/accountant in branch; warehouse blocked |
| `/contact/consultations` GET, `/:id` PATCH | Admin/boss/sales in branch; `{items,assignees}`, revision |
| `/content` GET | Public published entries only |
| `/admin/content` GET/POST, `/:id` PATCH, `/initialize` POST | Admin/boss; validation/revision/audit; insert-only defaults |
| `/reviews/:productId` GET/POST | Public read; verified B2B purchaser submits pending review |
| `/admin/reviews` GET, `/:id` PATCH | Admin/boss; publish/reject with revision/audit |
| `/admin/reports` GET, `/remind` POST | Admin/boss/sales/accountant in branch; days 1-365; daily deduplication |
| `/admin/integrations/kiotviet/reconciliation` GET, `/pull` POST | Admin/boss in branch; stored read-only comparison |

Frontend routes/payloads: FE `docs/experience-rollout.md`. Customer requests never
directly change totals. Approved snapshots affect the effective order and PDF.
The consultation GET response changed from an array to `{items,assignees}`.

## Notifications

Events: new/save/advance/cancel order, warehouse shortage, due-date update,
approval request/decision, B2B registration/activation/suspension, receipt
reconciliation/reversal, manual overdue reminder, new consultation, pending
review and Kiot discrepancies. Staff recipients are role/branch restricted.
B2B order/payment events respect settings (order index 0, payment/debt index 1).
Warehouse receives confirmed-order notices, not financial inbox items.
Frontend polls every 30 seconds while visible. No SMTP/Zalo delivery or WebSocket
transport is implied. Notifications are prospective, not replayed history.

## PDF And Media

PDFKit uses Vietnamese Noto Sans in `assets/fonts/NotoSans.ttf`; provenance and
OFL license are alongside it. Build copies fonts into `dist/assets/fonts` and
runtime supports repo-root/output-only hosting. Keep fonts/certs/media in deploy.
PDF includes branch/customer/revision, approved prices, shipping/discount, total,
delivery/payment. It is not a tax invoice, signed quote or immutable document;
downloads reflect current authorized order data. Existing media validation and
persistent upload storage remain in use.

## Reports

Period KPIs count branch orders by Asia/Ho_Chi_Minh business date. Self-order rate:
website B2B / all B2B orders in the period. Activation is the current directory,
not a reconstructed historical metric. Confirmation time uses recorded history
and creation time; missing/invalid timings are excluded rather than reported zero.
Aging uses actual posted credit amounts minus reconciled order receipts, bounded
by current debt. Missing legacy invoice dates/residual balances remain unknown.
Manual adjustments and legacy payment allocation require accounting reconciliation.
Reminder amount is server-derived; events deduplicate per recipient/business day.

## Kiot Scope

Manual connector/outbox remains. Pulls compare mapped product/customer IDs,
branch inventory `onHand`, retailer-wide customer `debt`, and raw order
`statusValue`. Missing/null/invalid balances are unverified, never assumed zero.
Product code/unit must match; stock is a nonnegative safe integer. Each attempt
is recorded, and a failed attempt does not replace the last successful snapshot.

```dotenv
KIOTVIET_ENABLED=false
KIOTVIET_POLL_ENABLED=false
KIOTVIET_POLL_MINUTES=15
```

Set retailer/client secrets and `KIOTVIET_BRANCH_MAP` in private env only. After
mapping/vendor acceptance, both flags true enable polling (minimum 5 minutes).
Timer starts after bootstrap and does not block listen; first call is after the
first interval. An enabled admin assigned to each branch is required.

This is NOT authoritative stock/debt/status synchronization. No ledger posting,
receipt, physical issue or order transition is applied from these snapshots.
Kiot customer debt is retailer-wide, not branch debt. Financial writeback needs
an agreed source-of-truth policy and accountant/vendor acceptance.
Polling lock is per process; use one polling instance until distributed leasing
exists. Large pulls may exceed proxy timeouts: inspect stored attempts before
retrying. No blind resend of external orders is enabled.
Reference: [Kiot official Public API](https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/).

## Deployment And Tests

1. Rotate secrets previously shared in chat; back up DB/persistent media.
2. Stage on a clone. Review TypeORM changes before `DB_SYNCHRONIZE=true`; sync can
   alter/delete data. This release was synchronized to local DB only.
3. Deploy `npm ci`, `npm run build`, entry `dist/main.js`, fonts/certs/media included.
   Use HTTPS, NODE_ENV=production, COOKIE_SECURE=true and correct origins.
4. Production keeps `SEED_MOCK_DATA=false`. Initialize CMS explicitly through its
   audited admin action or author content. Check images before FE cutover.
5. Disable sync after reviewed schema update. Verify roles/ownership/PDF,
   publication/reviews and complete order/approval flow on staging.

```sh
npm run typecheck
npm test
npm run test:operations
npm run test:products
npm run test:experience
```

Experience tests create a disposable schema on `.env.local` PostgreSQL localhost,
API port 4005, random seed passwords, and drop only that schema afterwards.
Positive Kiot tests inject a stub client; no live vendor calls/writes occur.
Other API suites use separate disposable schemas/ports. Never target production.

Remaining: live Kiot/SMTP acceptance, automatic financial sync, opening-invoice
import, banks/refunds/returns, tax invoices, MFA, global pagination, notification
retention and production observability/backups/acceptance.
