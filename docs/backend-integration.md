# Backend Integration

Cap nhat 04/10/2026. Stack theo yeu cau: NestJS, TypeScript, TypeORM
synchronize, Supabase PostgreSQL, JWT; seed mock cu va luu anh tren backend.
Giu giao dien frontend. Tai lieu nay thay hien trang preview trong api-handoff.md.
Cap nhat cau truc 05/10/2026: src/, shared/, media/, scripts/, seed/, certs/,
test/ va package.json nam tai goc repo BE, khong con folder backend/.
Next.js cung nam ngay tai goc repo baotin-b2b-fe rieng (app/, components/,
lib/, scripts/, shared/, package.json), khong con frontend/ trung gian.

## Ket Noi Va Chay

API hien dung Supabase **Session pooler** port 5432 theo URL nguoi dung
cung cap, luu rieng trong .env ignored (mode 600). TLS da xac minh
CA + hostname, DB_SSL=true, DB_SSL_CA_FILE=./certs/prod-ca-2021.crt; khong
tat verify. CA cong khai tai tu URL dashboard chinh thuc, provenance va
fingerprint trong certs/README.md.
Schema baotin_app ban dau khong co bang; TypeORM da synchronize 11 bang,
seed 63 products, 8 categories, 7 customers, 18 orders, 3 approvals va
12 users. Khong thay doi public/auth/storage.
Supabase direct host khong truy cap duoc tu mang may nay; khong can direct
host khi da dung Session pooler. .env.local va PostgreSQL
127.0.0.1:5441/baotin_dev van giu rieng cho integration tests.
Doc: https://supabase.com/docs/guides/database/connecting-to-postgres

Chay API bang npm ci, npm run dev tai goc repo BE theo ../README.md.
Tai goc repo FE, .env.local theo .env.example:
NEXT_PUBLIC_API_MODE=true, BACKEND_URL=http://127.0.0.1:4000.
Root FE `npm run dev -- --port 3010`; API localhost:4000/api/health.
Next proxy /api/backend/* -> /api/* va images/media. Khong public DB/JWT env.
Backend hien bind 127.0.0.1, deploy container can cau hinh bind/proxy rieng.
API_MODE=false la preview cu; anh van can media server BE. Khong tu fallback
mock khi API loi; doi NEXT_PUBLIC_* can restart/rebuild frontend.

## Cau Truc Va Seed

- src/database: DataSource, entities va SeedService.
- src/auth/catalog/orders/admin/account/media: modules nghiep vu.
- shared/: types, pricing va rules Sales/approval/warehouse/accounting.
- FE lib/api-client.ts: fetch same-origin, cookie, errors.
- FE lib/server-api.ts: product SSR, hidden SKU 404.
- FE components/admin/api-admin-provider.tsx: state va commands API.

Schema rieng baotin_app, cam public/auth/storage. Tao schema neu chua co,
goi synchronize() khi DB_SYNCHRONIZE=true, khong dropSchema/migration.
SYNCHRONIZE CO THE LAM MAT DU LIEU KHI DOI ENTITY: backup truoc thay doi,
khong xem cau hinh nay la an toan production.

11 bang: products, categories, customers, users, sessions, orders, approvals,
receipts, audit_events, leads, newsletter_subscriptions. Ownership/branch/version/timestamps la columns;
payload JSONB giu contract mock. Chua normalized ledger/FK day du.
Commands validate references va transaction tren server.

63 SKU, 8 categories, 7 B2B customers, 18 orders, 3 approvals export tu
lib/catalog.ts va lib/admin-preview.ts o goc repo FE bang
`FRONTEND_DIR=../baotin-b2b-fe npm run fixtures` tai goc BE.
INSERT ON CONFLICT DO NOTHING, khong overwrite khi restart,
khong lay localStorage lam seed; seed bi cam o production.
Seed orders bo sung **pickup details minh hoa** tu contact fixture va note
seed; phone khach le demo, khong che dia chi giao that. Stock/debt la snapshot
mock. Guide/slide/solutions/reviews van o frontend, chua co CMS API.

## Auth Va Quyen

Passwords scrypt salted. Cookie baotin_session HttpOnly, SameSite=Lax,
JWT HS256 2 gio, fixed issuer/audience, session ID persisted DB. Remember
chi giu cookie toi 2 gio, khong gia han token. Logout revoke session.
Role/branches/customerId doc tu DB moi request, khong tin client.
Khach moi pending, limit/debt=0; activate khong tu cap han muc, suspended bi chan.
API mode bo qua preview identity/orders trong localStorage.
Cart/favorites cache API dung key baotin-commerce-api-v1; preview cu giu
nguyen baotin-commerce-v1, khong xoa don demo cu khi chuyen che do.

Guest orders thuoc HTTPOnly UUID cookie baotin_guest, khong truy van bang
ma don cong khai; mat cookie mat quyen xem guest orders. Staff login /admin,
B2B khong co admin access. Branch chi thao tac theo user.branches.

| Role | Lenh |
| --- | --- |
| admin | Tat ca tren branches duoc gan |
| boss | Duyet gia/cong no, customer status, publication |
| sales | Tao/sua/xac nhan/huy, xin duyet, customer, publication, kho |
| warehouse | Queue da confirm: pick, shortage, soan/ban giao |
| accountant | Receipt, reconcile, void, due date |
| b2b | Own account/orders/preferences va personalized catalog |

Kho bi redaction prices/debt/approvals/receipts, UI chi mo kho. Staff khac
hien co read model chung theo branch; server gioi han write roles. Mot so
nut van hien cho role khong du quyen va tra 403; can permission-aware UI
chi tiet truoc production. Chua co user/role management screen.

Writes can Origin trong FRONTEND_ORIGINS va X-BaoTin-Client:web; DTO
whitelist/forbidNonWhitelisted. Auth/register/upload co rate limit.
Production can HTTPS + COOKIE_SECURE=true; chua co MFA/recovery email.

## API Contract

| Method | Backend path | Input / view |
| --- | --- | --- |
| GET | /api/health | API va DB health |
| POST | /api/auth/login | identity, password, remember? |
| POST | /api/auth/register | name/company/phone/email/password |
| GET | /api/auth/session | user/customer/role/branches |
| POST | /api/auth/logout | Revoke session |
| GET | /api/catalog | Published catalog, customerPrice sau auth active |
| GET | /api/catalog/:slug | Retail detail cho SSR |
| POST | /api/orders/quote | items(productId/quantity), delivery, coupon |
| POST | /api/orders | Quote input + customer/payment/note/expectedTotal? |
| GET | /api/orders | Own B2B hoac guest orders |
| GET | /api/admin/state | Scoped state, today server |
| POST | /api/admin/commands | action/branch/id?/expectedRevision?/payload |
| GET | /api/account | Profile/preferences/own reconciled payments |
| PATCH | /api/account/profile | name/company/phone/email/tax/address |
| PATCH | /api/account/preferences | addresses/settings/favorites |
| POST | /api/media/products/:id/image | Multipart image, authorized staff |
| POST | /api/contact/consultations | name/phone/email/message, persisted lead |
| POST | /api/contact/newsletter | email, subscription idempotent |
| GET | /api/contact/consultations | Admin/boss/Sales Quy Nhon, 100 leads moi nhat |

Gia/stock/phi/coupon tinh server, khong nhan unitPrice/total/customerId.
expectedTotal de phat hien gia doi. Idempotency-Key UUID bat buoc, unique DB;
cung request tra cung don, khac body/owner tra 409. Checkout/admin/account
chung orders service. Website order chua ho tro sua o Sales editor (can requote
policy). Sales form tao ho chua tinh shipping/coupon/thue.

14 admin commands xem src/admin/admin.dto.ts, rules xem shared/.
Order commands can expectedRevision, stale tra 409. PostgreSQL advisory
transaction lock serialize pilot commands (mot lock/DB); can row locks khi scale.
Price/credit approval co snapshot, khong tu confirm/xuat kho. Receipt validate
amount/reference, reconcile/void/audit persisted; KHONG tru opening debt mock.
Ngay admin va receipts lay server time Asia/Ho_Chi_Minh, khong previewDate.

## Media

Anh goc da chuyen frontend/public/images -> media/images trong repo BE, relative
URL /images/* duoc Next rewrite. Upload /media/uploads/UUID.webp, URL luu
Product.image/gallery, binary luu disk backend, khong luu PostgreSQL.
Max5MB JPEG/PNG/WebP, Sharp validate bytes max20MP, rotate, resize<=2000px,
encodeWebP; bo filename client, khong SVG. Admin products co upload control.
media/images version trong Git; uploads ignored. Can persistent volume va
backup cung DB, khong dung ephemeral serverless filesystem. Chua delete/reorder
gallery API; anh cu giu trong gallery. Mock assets chua verify moi SKU.

## Kiem Thu Va Gioi Han

Supabase smoke ngay 04/10/2026 da pass: TLS authorized, health va catalog
qua Next proxy, user IDs API khop DB Supabase, JWT HttpOnly, login/logout
admin/B2B, dashboard va bao gia server. Playwright storefront/detail o
1440/768/390/320px: anh khong loi, khong tran ngang, font Inter; login admin,
B2B account reload, san pham lien quan va bundle load. Chi tao/huy auth
sessions, khong tao/sua don hay du lieu kinh doanh. Sau QA van 63 products,
18 orders, 12 users, sessions=0; TypeORM schema diff co 0 lenh can dong bo.
Screenshots /tmp/bao-tin-ui-qa/supabase. Khong thay the full integration tests
bang smoke-test nay.

`npm test` tai goc BE: passwords/domain guards.
`npm run test:api`: JWT/CSRF/branch/roles, ownership/pending, server quote,
idempotency/revision, checkout->Sales->warehouse->account, approval/receipt,
publication/upload/logout. Chi local DB, cleanup ban ghi test.
`npm run test:connected`: Playwright desktop/tablet/mobile, checkout/Sales/account
reload, images, HTTPOnly cookie, accounting/upload control. Screenshots /tmp.
Lenh nay chay tu repo FE voi QA_BACKEND_DIR tro toi goc repo BE.
Hai bo test ghi/xoa du lieu va chi duoc chay voi API `dev:local` + database
`.env.local`; dung API Supabase truoc khi chay. Frontend proxy phai tro den
API local cho connected QA. Hostname API localhost khong co nghia DB local.
Preview QA cu can API_MODE=false, khong chung assertion cho API mode.

Chua production-ready: can KiotViet sync,
gia group/customer/effectivity, stock theo branch + tru/hoan ton, credit ledger
va reserve han muc cac don dang mo (hien guard chi snapshot mock), bank/refund,
notifications, CMS/reviews, password recovery/MFA, staff management, fine-grained
read permissions, pagination/OpenAPI, deployment/backup/observability.
Contact/newsletter da luu DB, chua gui email/thong bao va chua co man hinh
xu ly leads. Reviews submit tren product van la preview client, khong persisted.
Frontend Next.js 14.2.35 hien bi npm audit bao high/critical. Can nang len
ban patched duoc ho tro va regression-test truoc deploy; chua lam major
framework upgrade trong dot noi API nay. Backend runtime audit hien 0 vulnerabilities.
Khong mo ban that chi vi local tests pass hoac Supabase da ket noi.

DB credential da gui qua chat: nen rotate password va cap nhat ignored env;
khong commit/log credential. Production dung DB user rieng, khong postgres
superuser, tach seed accounts khoi tai khoan kinh doanh.
