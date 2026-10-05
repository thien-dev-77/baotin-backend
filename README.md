# Bao Tin Backend

NestJS 11, TypeScript, TypeORM PostgreSQL va JWT HttpOnly cookie.
Repo backend tach rieng cho [Bao Tin frontend](https://github.com/thien-dev-77/baotin-b2b-fe).
Frontend khong duoc dong goi trong repo nay.

```txt
src/      NestJS API modules
shared/   Types, pricing va business rules duoc API su dung
media/    Anh mau va uploads runtime
seed/     Mock fixtures
scripts/  Export fixtures va PostgreSQL local
test/     Unit va integration tests
certs/    Supabase public CA
docs/     Trang thai tich hop va API contract
package.json, tsconfig.json, .env.example, compose.yml
```

Tat ca nam ngay tai goc repo, khong con folder backend/ trung gian.
Giu src/ va shared/ trong cung repo. Yeu cau Node.js >=20.

## Chay API

```sh
# Chay ngay tai goc repo baotin-b2b-be
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

API hien bind 127.0.0.1:4000. Health: http://localhost:4000/api/health.
Next.js dung BACKEND_URL=http://127.0.0.1:4000 va NEXT_PUBLIC_API_MODE=true,
proxy /api/backend/* sang /api/*, /images/* sang /media/images/* va
/media/* sang /media/*. Frontend origin phai nam trong FRONTEND_ORIGINS.

## Anh Va Du Lieu

Anh mau trong media/images duoc version trong Git. Anh upload luu
tren disk media/uploads, ignored; can persistent volume va backup.
Khong luu binary trong PostgreSQL, khong dung Supabase Storage.
.env, .env.local, node_modules, dist, .localdb va upload runtime khong duoc push.

Seed da kem san, build/start khong can frontend. Tool export mock doc source
tu repo FE rieng, khong dong goi FE vao repo BE:

```sh
FRONTEND_DIR=../baotin-b2b-fe npm run fixtures
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
```

`npm run test:api` ghi/xoa du lieu kiem thu: chi chay voi PostgreSQL local va
API `npm run dev:local` dung .env.local, KHONG chay voi API tro den Supabase.
Full browser QA chay tu repo frontend va can ca hai services;
QA_BACKEND_DIR phai tro toi GOC repo BE nay, khong them /backend.

Doc [Backend Integration](docs/backend-integration.md) cho API, auth, quyen,
server quote, orders/admin/account, uploads va backlog. Hien chua co KiotViet,
stock/credit ledger that, bank/payment gateway hay production deployment.
