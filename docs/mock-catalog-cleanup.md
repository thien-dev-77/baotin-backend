# Don catalog mock de import san pham that

Ngay 13/10/2026, da sao luu va don du lieu fixture trong schema `baotin_app`
tren Supabase theo yeu cau cua chu du an. Sau don, kiem tra truc tiep database
xac nhan khong con 63 san pham, 8 danh muc va 18 don hang fixture.

## Pham vi da xu ly

- Xoa 18 don mock, 3 phe duyet cua cac don do, 4 so du ton kho, 6 dong so kho
  phat sinh tu don mock va 14 thong bao cua cac don mock.
- Xoa 63 san pham va 8 danh muc co ID/slug trong `seed/mock.json`.
- Bo ID san pham mock khoi danh sach yeu thich cua 1 tai khoan.
- Tat 3 bang gia B2B mau de chung khong ghi de CK cua san pham that.
- Chuyen 12 banner/bai huong dan/bo giai phap dang tro den danh muc da xoa
  sang private. Giu noi dung de admin co the cap nhat va cong khai lai.

Tai khoan dang nhap, khach hang, sessions, audit history va file media duoc
giu lai. Khong co phieu thu, credit ledger hay lien ket KiotViet lien quan
trong database o thoi diem don.

## Sao luu va khoi phuc

Ban sao luu cac ban ghi bi xoa/cap nhat:
`backups/mock-catalog-2026-10-13T02-40-30-206Z.json`.

SHA-256:
`33539e62e63a31da35521b6bb2f3af8ac61841b763f5bf41d363ae609265afb9`.

Backup duoc ghi va fsync truoc mutation, doc lai de doi chieu checksum,
quyen file `0600`, thu muc backup ignored trong Git. Audit database luu
checksum va so luong ban ghi. Backup chi chua cac ban ghi bi tac dong, khong
phai dump toan bo database, va khong chua password hash tai khoan.

Khoi phuc chi khi can quay lai trang thai truoc don:

```sh
npm run cleanup:mock-catalog -- --restore backups/mock-catalog-2026-10-13T02-40-30-206Z.json --apply
```

Restore kiem tra checksum voi audit, dung transaction va tu choi ghi de
ID/slug da duoc tao lai hoac ban ghi da duoc sua sau don. Neu da import
san pham that hoac cap nhat noi dung, can doi chieu xung dot truoc restore.

## Cong cu maintenance

Chay tai thu muc backend. Mac dinh chi doc:

```sh
npm run audit:mock-catalog -- --fixture-only
npm run audit:mock-catalog
npm run cleanup:mock-catalog
```

Hai lenh cuoi doc cau hinh `ENV_FILE` (mac dinh `.env`), `DATABASE_URL`,
`DB_SCHEMA`, `DB_SSL`, `DB_SSL_CA_FILE`. Khong in credentials.

De don mock tren mot database khac da duoc chon dung trong env:

```sh
npm run cleanup:mock-catalog -- --apply
```

Cong cu khoa transaction cung advisory lock voi API, kiem tra tham chieu va
chi ghi sau khi backup duoc xac minh. No dung lai neu co don that tham chieu
san pham mock, san pham that dung danh muc/nhom bien the mock, danh tinh SKU
da thay doi, phieu thu/credit ledger, lien ket dong bo hoac so kho khong xuat
phat tu don fixture. Gia va noi dung da chinh sua cua san pham fixture van
duoc giu trong backup; khong xoa theo brand, ten san pham hay tat ca bang.

## Chan mock duoc tao lai

Database co bang maintenance `mock_seed_cleanup`, luu fixture goc va thoi
diem don. `SeedService` moi kiem tra marker nay va bo qua mock seed.

De bao ve deployment cu con bat seed, trigger tren products/categories/
orders/approvals bo qua insert neu payload trung dung fixture goc. Trigger
khong chan san pham/danh muc that voi payload moi, ke ca danh muc tai su
dung slug. Marker va trigger duoc tao cung transaction cleanup; TypeORM
khong can migration hoac thay doi entity cho bang maintenance nay.

`.env` local tro Supabase da dat `SEED_MOCK_DATA=false`. Deployment nen cung
dat `SEED_MOCK_DATA=false`; database guard da ngan fixture catalog/don hang
quay lai ngay ca khi deployment cu chua duoc cap nhat. `.env.local` danh cho
PostgreSQL development van giu fixture de test/preview.

## Buoc import tiep theo

Chi doc sheet dau tien (index 0), `Bảng Báo Giá Chi Tiết`, cua file Fulco. File co 242
SKU, 28 nhom, 19 dong thieu ten/anh va 4 dong co 12 anh (vuot gioi han 10).
Gallery can tai tu URL Fulco ve `MEDIA_DIR` ben vung, deduplicate 536 URL
anh khac nhau va luu path local vao san pham.

Chot mapping cot CK vao B2C/B2B, ma goc/ma moi va nhom bien the truoc ghi.
Importer sheet dau Fulco da duoc trien khai rieng va da import 242 SKU private.
Xem [Fulco Import](fulco-import.md); cleanup khong tu import workbook.
Frontend production can `NEXT_PUBLIC_API_MODE=true` de doc catalog API sach.
Catalog trong source frontend van phuc vu preview, khong seed vao database.

## Kiem thu

```sh
npm run test:mock-cleanup
```

Test dung PostgreSQL tam, kiem tra dry-run, chan don that, khong xoa khi
backup loi, backup quyen 0600, bao toan du lieu that, suppress seed tren code
cu/moi, cho phep danh muc that tai su dung slug, khoi phuc va chan backup
bi sua/xung dot restore. Khong dung Supabase cho test.
