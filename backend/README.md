# Bao Tin API

NestJS 11 + TypeScript + TypeORM 0.3 + PostgreSQL, JWT HttpOnly cookie.
Seed tu mock frontend, khong phai du lieu KiotViet.

## Chay

```sh
cd backend
npm ci
npm run dev
```

Can `.env` theo `.env.example`, DATABASE_URL truy cap duoc, JWT_SECRET ngau
nhien >=32 ky tu va SEED_PASSWORD >=12 ky tu. API localhost:4000/api,
health `/api/health`. Khong commit file env. `.env` hien dung Supabase
Session pooler port 5432; ket noi va seed da duoc xac minh ngay 04/10/2026.
DB_SSL=true va DB_SSL_CA_FILE=./certs/prod-ca-2021.crt; verify CA + hostname,
khong tat verify. CA cong khai va nguon tai xem [certs/README.md](certs/README.md).
Supabase direct host khong truy cap duoc tu mang may nay; pooler la duong
ket noi hien tai. DB_SCHEMA=baotin_app, DB_SYNCHRONIZE=true theo yeu cau.

## PostgreSQL Local

Dung `.env.local` rieng, database localhost:5441/baotin_dev, DB_SSL=false,
LOCAL_DB_PASSWORD va cac bien auth/seed nhu `.env.example`.
Khong thay URL Supabase trong `.env` bang local.

```sh
# Terminal 1, giu chay
npm run db:local
# Terminal 2
npm run dev:local
```

`embedded-postgres` la dev dependency, PostgreSQL that luu `.localdb/`;
wrapper hien beta. Co the dung PostgreSQL cai rieng, hoac Docker Compose:
`docker compose --env-file .env.local up -d`. Chi mot DB tren port 5441.

## Seed Va Tai Khoan

`npm run fixtures` export mock hien co sang `seed/mock.json`.
SEED_MOCK_DATA=true nap INSERT ON CONFLICT DO NOTHING; restart khong reset
thay doi; cam seed o production.
Tai khoan: admin@baotin.local, boss@baotin.local, sales@baotin.local,
warehouse@baotin.local, accountant@baotin.local, kh001@baotin.local...
kh007@baotin.local. Mat khau la **SEED_PASSWORD trong env cua DB do**.
Doi SEED_PASSWORD khong tu doi password tai khoan da seed.

## Kiem Thu

```sh
npm run build
npm test
# Dung API Supabase truoc, khoi dong db:local + dev:local roi moi chay tests
npm run test:api
```

API tests tao/xoa ban ghi test, chi duoc chay voi API dung `.env.local` va
PostgreSQL local, KHONG chay khi port 4000 dang phuc vu Supabase. Chi kiem
tra hostname localhost khong dam bao API dung local database. Doc
[backend-integration.md](../docs/backend-integration.md) ve API,
frontend proxy, media, quyen va gioi han truoc production.
