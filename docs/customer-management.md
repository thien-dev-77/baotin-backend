# B2B Customer Management

Implemented locally on 07 October 2026. This release covers customer profiles,
classification, Sales ownership, pilot selection and assisted phone onboarding.
It does not implement authoritative Kiot synchronization or the remaining pilot
KPI/feedback requirements in the business plan.

## API Contract

Every path below has the `/api` prefix. JWT HttpOnly cookie and existing
Origin/X-BaoTin-Client checks remain mandatory. Branch access is checked server-side.

| Endpoint | Behavior |
| --- | --- |
| `GET /admin/customers?branch=...` | Profile metadata, account presence, branch Sales and existing groups |
| `POST /admin/customers` | Create a pending customer; optional initial password creates a B2B account atomically |
| `PATCH /admin/customers/:id` | Revision-checked profile update; branch cannot change |
| `POST /admin/customers/:id/account` | Create the first login for an existing offline customer; never reset an existing password |

Reads: admin/boss/sales/accountant in the requested branch. Writes:
admin/boss/sales in that branch. Warehouse and B2B accounts have no directory access.

Create/update fields: `branch`, `name`, `contact`, `phone`, `email`, `tax`,
`address`, `group`, `assignedSalesId` (UUID or null), `pilot`, `notes`.
Update also requires `revision`. Create optionally accepts `password` (12-128
characters). Account creation requires `branch`, `revision`, `password` only.
Unknown fields, including financial fields and status, are rejected.

The response never includes passwords/hashes, reset tokens, sessions or customer
preferences. `GET` includes account ID/disabled flag only, not login credentials.
Email of a linked login is immutable through profile editing; an admin can change
it through existing user management. This prevents Sales taking over accounts
through email recovery. Login phone changes invalidate sessions/reset tokens.

## Business Rules

- New customer status is pending, limit/debt/overdue start at zero. Approval and
  suspension use the existing customer-status command, now with an optional
  profile revision in its payload. The frontend supplies it when available.
- Phone formatting follows the existing `phoneKey` normalization. Duplicate
  normalized phones are rejected across the customer directory and user accounts.
  No duplicate customer is created by public registration for an offline profile.
- Pilot customers require an enabled Inside Sales user in the same branch.
  Disabled Sales remain visible in the directory so existing ownership is legible.
  Choosing a disabled/out-of-branch/non-Sales assignee is rejected.
- Group classification follows existing approved price policies. Assigning a group
  does not create a new price policy or change an order's stored price snapshot.
- Profile writes preserve limits, terms, debt, reservations, orders, receipts,
  ledger entries and Kiot IDs. Profile/user company, contact, phone, tax/address
  update together; preferences remain intact.
- A phone-only login stores SQL NULL for email, not a fake email address. Public
  session DTOs still return `email: ""`, maintaining the frontend contract.
- Creating a login does not activate the customer or auto-send a password.
  Inside Sales must hand over the initial password through an agreed secure
  channel. Customers can change it using the existing settings screen.
  Email recovery needs a real email plus SMTP; no SMS/OTP/invite transport is added.
- No deletion/merge or branch transfer is added: existing order and debt references
  must remain stable. Resolve existing duplicate records with an approved process.
- Transactions use the existing advisory lock; profile versions prevent stale
  edits after status, terms, self-service profile and user-management changes.
- Audit actions: customer-create, customer-update, customer-account-create.
  Passwords are never placed in audit events or API responses.

## Deployment

Schema delta: `customers.revision` (version integer, default 1), `users.email`
becomes nullable while retaining its unique constraint. Profile metadata lives
in the existing customer JSONB; no new customer table or shared repo is added.

Back up before synchronization. Review the schema delta on a staging copy, then
apply through the approved TypeORM synchronize procedure. Do not delete or
reseed existing customers/users. This implementation has only been tested and
synchronized locally, not deployed to Supabase production. Deploy backend before
the new frontend. Keep production seed off and disable sync after validation.

## Verification

`npm run test:customers` creates/drops a disposable schema on `.env.local`
PostgreSQL localhost and starts a test API on port 4006. Never target production.
Coverage: roles/branch isolation, duplicate and concurrent creation, phone-only
login, pilot-owner validation, protected balances, revision conflicts, account
preferences, linked-email protection, session invalidation, offline onboarding,
financial/status changes and secret-free audits. Run `npm run test:operations`
for existing order/auth/accounting regressions.
