# Khôi phục banner và sản phẩm nổi bật

## Nguyên nhân

Sau khi dọn danh mục mock, ba banner cũ còn trỏ tới `phu-kien-bep`, `led-tu-ke`
và `phu-kien-lap-dat`, nên được ẩn để tránh link hỏng. API `/content` trả
`items: []`. Frontend vẫn dành chiều cao cho hero dù không có slide.
Catalog Fulco có 223 SKU công khai nhưng mọi SKU đều có `featured=false`,
nên tab Nổi bật không có sản phẩm.

## Cập nhật ngày 13/10/2026

Đã sao lưu dữ liệu tại file local bị Git ignore:
`backups/homepage/2026-10-13T13-52-09-614Z.json`.
Khôi phục ba banner với ảnh backend hiện có, lần lượt trỏ tới:
`phu-kien-tu-bep`, `phu-kien-tu-bep-duoi`, `phu-kien-tu-bep-tren`.
Không công khai lại guide/solution thuộc các nhóm mock đã bỏ.

Đánh dấu 10 SKU công khai là nổi bật:
FC36S-600-304, NSP-00179, FC202, FC-D7546-304, F66, FC225,
FCH201A-700, FCH614-WD-600, FC-ML638i, FC589.
Chọn nhiều dòng sản phẩm, mỗi nhóm biến thể chỉ một SKU đại diện.
Giữ mọi flag nổi bật đã có; không sửa giá, chiết khấu, stock, ảnh, nhóm biến thể
hay trạng thái công khai của bất kỳ sản phẩm nào. Không tạo đơn, review hoặc
lịch sử mua giả. Tồn kho nhập hiện tại bằng 0, phải cập nhật theo số lượng thực.

Banner sửa ở `/admin/content`, sản phẩm nổi bật sửa trong form `/admin/products`.

## Công cụ bảo trì

```sh
npm run catalog:repair-homepage
npm run catalog:repair-homepage -- --apply
```

Mặc định chỉ preview. `--apply` dùng lock chung với API và row locks, kiểm tra
ảnh, tạo backup quyền 0600, fsync và xác minh checksum trước khi ghi.
Chỉ phục hồi đúng ba banner fixture revision 2 đang ẩn vì danh mục cũ;
không sửa bản nháp do admin viết hay banner đã công khai. Chọn SKU thực sự
công khai, hợp lệ và nằm dưới danh mục hiển thị; ưu tiên SKU gốc của biến thể.
Cập nhật revision và audit `homepage-repair` trong cùng transaction.
Mọi trường sản phẩm ngoài featured/revision được đối chiếu sau ghi, lỗi rollback.
Chạy lại sau sửa không tạo thêm thay đổi/audit. Không chạy lúc server khởi động.

## Frontend

CMS không có banner: bỏ cả hero layout thay vì để khoảng trống 408px.
Không tự công khai banner admin đã chủ động ẩn.

Tab Nổi bật ưu tiên flag admin. Nếu chưa đánh dấu, gợi ý tối đa 10 sản phẩm
từ catalog API, đa dạng danh mục gốc, loại trùng biến thể và sản phẩm thiếu
nội dung/giá/ảnh hoặc nằm dưới danh mục ẩn. Không dùng mock ở API mode.

Khách chưa đăng nhập thấy tab **Gợi ý cho bạn**, không gọi API thường mua.
B2B active chỉ gọi `/account/frequently-bought` khi chọn tab Thường mua;
nếu API trả lịch sử rỗng, tab đổi tên Gợi ý cho bạn và dùng sản phẩm catalog.
Lịch sử có dữ liệu vẫn hiển thị đúng các SKU từng mua; lỗi API không được
đánh đồng với lịch sử rỗng. Đăng xuất xóa giá cá nhân và đổi sang gợi ý công khai.
Badge featured trên gallery là Nổi bật, không gọi là Bán chạy khi chưa có số liệu.

Data sửa đã xác nhận qua backend production. Cache public catalog tối đa 15 giây,
content 60 giây; frontend mới dùng content cache key mới. Code fallback/gợi ý
cần deploy frontend; lệnh bảo trì không tự push hay triển khai ứng dụng.

## Kiểm thử

Backend `npm run test:homepage-repair` dùng PostgreSQL local/schema QA riêng:
ảnh, preview, backup không ghi đè, bảo toàn dữ liệu, draft protection, idempotency.
Frontend `npm run test:homepage` kiểm tra chọn sản phẩm, SSR không JavaScript,
CMS rỗng, phục hồi banner qua cache invalidation và responsive 1440/768/390/320.
`tests/ssr.spec.ts` kiểm tra lịch sử mua on-demand, trường hợp rỗng và đăng xuất.
