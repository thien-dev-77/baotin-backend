# Bao Tin Backend

NestJS 11, TypeScript, TypeORM PostgreSQL va JWT HttpOnly cookie.
Repo backend tach rieng cho [Bao Tin frontend](https://github.com/thien-dev-77/baotin-b2b-fe).
Frontend khong duoc dong goi trong repo nay.

```txt
backend/  NestJS API, configuration examples, seed, media, tests
shared/   Types, pricing va business rules duoc API su dung
docs/     Trang thai tich hop va API contract
```

Giu `backend/` va `shared/` cung cap: imports va TypeScript build can ca hai.
Khong chi copy rieng backend/src. Yeu cau Node.js >=20.

## Chay API

```sh
cd backend
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
backend/seed/mock.json. Restart khong overwrite ban ghi da co.
Tai khoan demo va cau hinh xem [backend/README.md](backend/README.md).
Khong co credentials that trong repo; mat khau demo lay tu env cua may chay.

API hien bind 127.0.0.1:4000. Health: http://localhost:4000/api/health.
Next.js dung BACKEND_URL=http://127.0.0.1:4000 va NEXT_PUBLIC_API_MODE=true,
proxy /api/backend/* sang /api/*, /images/* sang /media/images/* va
/media/* sang /media/*. Frontend origin phai nam trong FRONTEND_ORIGINS.

## Anh Va Du Lieu

Anh mau trong backend/media/images duoc version trong Git. Anh upload luu
tren disk backend/media/uploads, ignored; can persistent volume va backup.
Khong luu binary trong PostgreSQL, khong dung Supabase Storage.
.env, .env.local, node_modules, dist, .localdb va upload runtime khong duoc push.

Seed da kem san, build/start khong can frontend. `npm run fixtures` la tool
export mock tu workspace day du; can frontend/ nam canh backend/ va shared/.
Khong chay tool nay trong clone backend-only. Tai lieu tich hop con ghi cac
duong dan/lenh cua workspace day du, khong co nghia frontend nam trong repo nay.

## Kiem Thu

```sh
cd backend
npm run typecheck
npm test
```

`npm run test:api` ghi/xoa du lieu kiem thu: chi chay voi PostgreSQL local va
API `npm run dev:local` dung .env.local, KHONG chay voi API tro den Supabase.
Huong dan DB local xem backend/README.md. Khi tach repo, full browser QA chay
tu repo frontend va can ca hai services.

Doc [Backend Integration](docs/backend-integration.md) cho API, auth, quyen,
server quote, orders/admin/account, uploads va backlog. Hien chua co KiotViet,
stock/credit ledger that, bank/payment gateway hay production deployment.
