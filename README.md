# Bao Tin Backend

Customer profiles and phone onboarding: [Customer Management](docs/customer-management.md).

NestJS 11, TypeScript, TypeORM PostgreSQL va JWT HttpOnly cookie.
Repo backend tach rieng cho [Bao Tin frontend](https://github.com/thien-dev-77/baotin-frontend).
Frontend khong duoc dong goi trong repo nay.
Ban cap nhat uu tien 1-6 va checklist staging:
[Operations Rollout](docs/operations-rollout.md).
Quan ly them/sua san pham, bo anh va che do rieng tu:
[Product Management](docs/product-management.md).

```txt
src/      NestJS modules, types va business rules cua BE
media/    Anh mau va uploads runtime
seed/     Mock fixtures
scripts/  Export fixtures va PostgreSQL local
test/     Unit va integration tests
certs/    Supabase public CA
docs/     Trang thai tich hop va API contract
package.json, tsconfig.json, .env.example, compose.yml
```

Tat ca nam ngay tai goc repo, khong con folder backend/ trung gian.
Runtime source chi nam trong src/: types o src/types/, rules o src/admin/rules/,
pricing o src/catalog/pricing.ts. Khong phu thuoc source FE khi build/start.
Build output: dist/main.js. Yeu cau Node.js >=20.

## Chay API

```sh
# Chay ngay tai goc repo baotin-backend
npm ci
cp .env.example .env
# Dien DATABASE_URL, JWT_SECRET va SEED_PASSWORD trong .env rieng
npm run build
npm start
# Hoac npm run dev de watch code
```

Supabase Session pooler port 5432: DATABASE_URL lay tu Supabase Connect,
DB_SSL=true, DB_SSL_CA_FILE=./certs/prod-ca-2021.crt. CA cong khai duoc kem
repo; backend verify CA + hostname. DB_SCHEMA=baotin_app, DB_SYNCHRONIZE=true
theo yeu cau hien tai. Synchronize co the thay doi/mat du lieu khi doi entity;
backup truoc, khong xem cau hinh nay la production-ready.

JWT_SECRET can ngau nhien >=32 ky tu, SEED_PASSWORD >=12 ky tu, khong dung
placeholder. SEED_MOCK_DATA=true chi cho development; production cam mock seed.
63 SKU, 8 categories, 7 B2B customers, 18 orders, 3 approvals duoc kem trong
seed/mock.json. Restart khong overwrite ban ghi da co.
Tai khoan demo: admin@baotin.local, boss@baotin.local, sales@baotin.local,
warehouse@baotin.local, accountant@baotin.local, kh001@baotin.local...kh007@baotin.local.
Mat khau la SEED_PASSWORD trong env cua DB do; doi bien nay khong tu doi
password tai khoan da seed.
Khong co credentials that trong repo; mat khau demo lay tu env cua may chay.

API development mac dinh bind 127.0.0.1:4000. Health: http://localhost:4000/api/health.
HOST co the ghi de; mac dinh production bind 0.0.0.0, development bind 127.0.0.1.
Next.js dung BACKEND_URL=http://127.0.0.1:4000 va NEXT_PUBLIC_API_MODE=true,
proxy /api/backend/* sang /api/*, /images/* sang /media/images/* va
/media/* sang /media/*. Frontend origin phai nam trong FRONTEND_ORIGINS.

## Deploy Cloud / Hostinger

Build `npm run build` compile code va chep CA cong khai, seed mock, anh mau
vao `dist/certs/`, `dist/seed/`, `dist/media/images/`. Khong chep private env,
private keys hay uploads. Chi dung `tsc` se KHONG dong goi cac runtime assets.
Duong dan tuong doi tim asset o repo goc, neu khong co thi dung ban kem theo
compiled runtime; khong phu thuoc working directory cua cloud.

Cau hinh: framework NestJS, Node.js 22.x, branch main, root `./`, build
`npm run build`, output directory `dist`, entry file `main.js`.

```dotenv
NODE_ENV=production
HOST=0.0.0.0
COOKIE_SECURE=true
SEED_MOCK_DATA=false
DB_SSL=true
DB_SSL_CA_FILE=./certs/prod-ca-2021.crt
MEDIA_DIR=./media
```

PORT phai khop port reverse proxy/cloud cap; khong tu ghi de neu platform
da cung cap PORT. FRONTEND_ORIGINS can domain HTTPS frontend dung thuc te.
DATABASE_URL va JWT_SECRET chi nhap trong secret/env cua backend.
Du lieu mock da seed trong Supabase se van ton tai khi SEED_MOCK_DATA=false;
khong dat NODE_ENV=development chi de seed lai database dang co.
Truoc production, backup va tat DB_SYNCHRONIZE sau khi schema da duoc tao.

ENOENT la loi file/path khong ton tai, khong mac dinh la loi ket noi DB.
Startup log chi in error code va path file thieu, khong in connection URL,
error message/stack co the chua password. Kiem tra `/api/health` va
`/media/images/locks/499-21-226.jpg` sau deploy; ca hai phai tra 200.

Anh upload can persistent volume: MEDIA_DIR co the la absolute path cua
volume chua ca `images/` va `uploads/`; anh mau can copy vao volume truoc.
Khong coi `dist/media/uploads` la storage ben vung qua moi lan redeploy.
Neu secret bi lo trong anh/log, doi DB password va JWT secret tren cac may
chay. Doi SEED_PASSWORD KHONG doi password tai khoan da seed; can reset
password cua cac tai khoan do va thu hoi sessions cu.

## Anh Va Du Lieu

Anh mau trong media/images duoc version trong Git. Anh upload luu
tren disk media/uploads, ignored; can persistent volume va backup.
Khong luu binary trong PostgreSQL, khong dung Supabase Storage.
.env, .env.local, node_modules, dist, .localdb va upload runtime khong duoc push.

Seed da kem san, build/start khong can frontend. Tool export mock doc source
tu repo FE rieng, khong dong goi FE vao repo BE:

```sh
FRONTEND_DIR=../baotin-frontend npm run fixtures
```

FRONTEND_DIR tro toi folder Next.js co tsconfig.json va lib/; mac dinh nhu
vi du tren. Next.js nam ngay tai goc repo FE, khong con frontend/ trung gian.

## PostgreSQL Local

Dung .env.local rieng: DATABASE_URL cho 127.0.0.1:5441/baotin_dev,
DB_SSL=false, LOCAL_DB_PASSWORD va cac bien auth/seed nhu .env.example.
Khong thay cau hinh Supabase trong .env bang local.

```sh
# Terminal 1
npm run db:local
# Terminal 2
npm run dev:local
```

PostgreSQL local luu .localdb/, ignored. Wrapper embedded-postgres hien beta;
co the dung PostgreSQL cai rieng hoac `docker compose --env-file .env.local up -d`.
Chi mot database tren port 5441.

## Kiem Thu

```sh
npm run build
npm run typecheck
npm test
npm run test:operations
npm run test:experience
```

`npm run test:api` ghi/xoa du lieu kiem thu: chi chay voi PostgreSQL local va
API `npm run dev:local` dung .env.local, KHONG chay voi API tro den Supabase.
Full browser QA chay tu repo frontend va can ca hai services;
QA_BACKEND_DIR phai tro toi GOC repo BE nay, khong them /backend.

Doc [Backend Integration](docs/backend-integration.md) cho API, auth, quyen,
server quote, orders/admin/account, uploads va backlog. Da co pricing/stock/credit
ledger, account management/recovery va website edit. KiotViet connector/outbox
can credentials va acceptance; SMTP can cau hinh de gui email that.
Chua co auto Kiot stock/debt/status sync, bank/refund hay production acceptance.

Doc [Experience API Rollout](docs/experience-rollout.md) cho thong bao admin/B2B,
B2B xin gia/thuong mua, PDF, xu ly tu van, CMS/reviews, KPI/tuoi no va read-only polling.
