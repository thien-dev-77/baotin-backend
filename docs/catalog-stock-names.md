# Tồn đầu 100 và tên sản phẩm chữ thông thường

## Kết quả ngày 13/10/2026

Theo xác nhận của chủ dự án: đặt tồn hiện tại 100, vẫn giữ cơ chế giữ hàng và
trừ khi xuất. Không hiển thị số cố định giả trên frontend/API.

Đã đặt tồn 100 cho toàn bộ 242 SKU tại Quy Nhơn, Tuy Hòa và Nha Trang, tạo 726
số dư kho. Trước thay đổi không có số dư kho hay đơn hàng nào. Đã ghi 726 bút toán
điều chỉnh tồn cùng audit `catalog-stock-name-refresh`, resource `catalog-stock-names-v1`.
Đã đổi 213 tên; 29 tên phù hợp được giữ nguyên. Có 223 SKU công khai, 19 private;
không tự công khai các SKU thiếu nội dung/ảnh.

Bản sao lưu trước thao tác: file local quyền 0600, nằm ngoài Git:
`backups/catalog-refresh/2026-10-13T14-17-00-601Z.json`.
Bao gồm products, inventory, orders và sổ kho trước cập nhật; fsync và xác minh
SHA-256 trước ghi. Không đổi giá/chiết khấu, ảnh, SKU, URL, nhóm danh mục, thuộc
tính biến thể, flag nổi bật hay trạng thái công khai. Snapshot đơn cũ không sửa.

## Cách viết tên

Ví dụ `GIÁ BÁT ĐĨA TỦ TRÊN INOX OVAL 304` thành
`Giá bát đĩa tủ trên inox oval 304`.
Viết hoa đầu tên, phần còn lại dùng chữ thường; giữ dấu tiếng Việt, SKU/mã mới,
thương hiệu Fulco/Kanger, tên Nhật, ký hiệu SUS304/LED/ABS/PVC/USB và đơn vị L/V/W/Hz.
Giữ nguyên dạng mã như `FC-JP668i-Plus`, không sửa chính tả hay nội dung kỹ thuật
ngoài thay đổi kiểu chữ. Không dùng CSS lowercase trên frontend.

Helper `src/catalog/product-name.ts` được dùng cả khi import Fulco mới để tránh
lấy lại tên HOA TOÀN BỘ từ Excel. Import mới vẫn để tồn 0 nếu file không có tồn;
thao tác tồn 100 chỉ dành cho catalog hiện có được người dùng xác nhận lần này.

## Bảo toàn nghiệp vụ kho

Tồn khả dụng vẫn bằng `onHand - reserved`, chặn âm. Đơn xác nhận giữ hàng;
xuất hàng trừ số dư của đúng chi nhánh qua LedgerService hiện có.
Nếu đang giữ nhiều hơn 100 cho một SKU, lệnh dừng thay vì đặt tồn thấp hơn lượng giữ.
Không xóa đơn, không xuất vượt tồn, không thay đổi đồng bộ Kiot.

```sh
npm run catalog:refresh-stock-names
npm run catalog:refresh-stock-names -- --apply
```

Mặc định preview, `--apply` mới ghi. Lệnh dùng `.env` hoặc `ENV_FILE`, lock advisory
chung với API, row locks, backup và transaction; cập nhật JSONB theo batch.
Revision sản phẩm tăng để chặn admin lưu nháp cũ đè lên dữ liệu vừa cập nhật.
Sau ghi, đối chiếu để đảm bảo chỉ name/stock/revision thay đổi ở products.
Số dư kho và ledger adjustment/audit cùng commit; bất kỳ lỗi nào cũng rollback.

Đây là thao tác một lần. Audit key ngăn chạy lại đặt hàng đã xuất về 100.
Không chạy lệnh này khi server khởi động. Những lần điều chỉnh sau phải dùng
admin sổ kho có target/expected/reason theo tồn thực tế. Backup không nằm trên Git.

## Kiểm thử

`npm run test:catalog-refresh` dùng schema PostgreSQL local riêng:
name casing/Unicode/SKU, giới hạn reservation, private flags, backup không đè,
bảo toàn trường sản phẩm, stock ledger và lần chạy lại.
Kiểm thử gọi đúng LedgerService.handoff: xuất 3 món tại Quy Nhơn giảm 100 xuống 97,
Tuy Hòa/Nha Trang vẫn 100; chạy lại maintenance không hoàn lại tồn đã xuất.
`npm run test:fulco` kiểm tra import mới chuẩn hóa tên nhưng giữ giá/biến thể/tồn 0.
`npm test` kiểm tra các quy tắc giá, tồn giữ chỗ, đơn và runtime.

Dữ liệu đã được xác nhận qua API production. Frontend dùng API hiện có nên không
cần sửa component hay hardcode tồn. Cache catalog tối đa 15 giây; tải lại nếu
trình duyệt còn giữ tên/tồn cũ. Code import/helper mới cần push/deploy backend.
