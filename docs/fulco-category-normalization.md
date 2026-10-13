# Chuẩn hóa danh mục Fulco

## Dữ liệu đã cập nhật

Ngày 13/10/2026, đối chiếu ảnh danh mục Fulco do chủ dự án cung cấp với dữ liệu
Supabase hiện tại. Trước thay đổi có 28 danh mục phẳng, nhiều tên chứa chất liệu
và bảo hành từ tiêu đề Excel. Sau thay đổi có 44 danh mục, gồm 5 danh mục gốc.
Không xóa danh mục cũ, giữ cả 28 slug để URL không bị mất.

Đã chuyển 45 SKU từ nhóm tổng hợp sang nhóm con phù hợp. Tổng số vẫn là 242 SKU:
223 công khai, 19 private. Không sửa tên/mã sản phẩm, giá, chiết khấu, tồn kho,
gallery, biến thể hoặc trạng thái công khai. Không đụng đơn hàng, tài khoản hay ảnh.

Bản sao lưu trước cập nhật nằm trong thư mục local bị Git ignore:
`backups/fulco-taxonomy/2026-10-13T08-12-41-661Z.json`.
File có quyền 0600, được fsync và xác minh SHA-256 trước khi ghi database.
Audit event: `category-tree-normalize`, resource `fulco-category-tree-v1`.

## Cấu trúc tham khảo

| Danh mục cha | Danh mục con |
| --- | --- |
| Hệ thống chậu - Vòi rửa | Vòi rửa; Chậu rửa |
| Phụ kiện mộc nội thất | Phụ kiện khác; Piston hơi & thủy lực; Hệ thống tay nâng; Ray trượt; Bản lề |
| Phụ kiện tủ quần áo | Giá để giày; Ngăn kéo để đồ; Giá treo quần âu cao cấp; Giá nâng hạ cơ treo quần áo |
| Phụ kiện tủ bếp | Hệ thống phụ kiện góc; Tủ đồ khô - Tủ kho; Thùng gạo - Thùng rác; Phụ kiện tủ bếp dưới; Phụ kiện tủ bếp trên |
| Thiết bị bếp & Đồ gia dụng | Xoong & Nồi; Nồi cơm điện; Máy rửa bát; Máy hút mùi; Bếp từ |

Phụ kiện tủ bếp dưới có ba nhóm: **Giá đựng chất tẩy rửa & gia vị**,
**Giá bát đĩa - Xoong nồi**, **Khay chia thìa - Dĩa**.
Phụ kiện tủ bếp trên có **Giá bát cố định**, **Giá nâng hạ**, **Giá nâng hạ điện**.
Các nhóm nan tròn, nan oval, nan dẹt và xước mờ giữ riêng ở cấp thứ tư, không
trộn sản phẩm hay biến thể. Mâm xoay nằm dưới phụ kiện góc; thùng gạo và thùng rác
là hai nhóm con riêng dưới nhóm chung.

Bốn nhóm chưa có SKU (Phụ kiện khác, Piston hơi & thủy lực, Ray trượt, Bản lề)
đã tạo nhưng tạm ẩn, chưa có ảnh. Thêm sản phẩm và tải ảnh trước khi bật hiển thị
trong admin. Không thêm các danh mục nằm ngoài phần ảnh tham khảo nhìn thấy.

## Phân loại SKU tổng hợp

| Nhóm Excel cũ | Cách phân lại |
| --- | --- |
| Chậu, vòi rửa bát | 11 SKU vòi rửa; 14 SKU chậu rửa |
| Phụ kiện nội thất | FC225, FC228 vào Hệ thống tay nâng |
| Phụ kiện tủ quần áo | FCH201A/FCH303: treo quần âu; FCH203/FCH205: ngăn kéo; FCH207B/FCH403: giá giày; FCH614-WD: nâng hạ treo áo |
| Thiết bị bếp gia dụng | FC-50EC12T/FC-70NC18P-T/X: nồi cơm; FC115: xoong/nồi; FC99/FC996: bếp từ |

Ánh xạ đầy đủ ở `src/catalog/fulco-taxonomy.ts`. Mã lạ trong nhóm cần phân lại
hoặc một nhóm biến thể bị tách sang hai danh mục sẽ dừng toàn bộ thao tác.

## Vận hành

```sh
npm run catalog:normalize-fulco
npm run catalog:normalize-fulco -- --apply
```

Lệnh mặc định chỉ đọc và xem trước. `--apply` dùng `.env` hoặc `ENV_FILE` đã chọn;
không in URL database/secret. Khóa advisory giống API, khóa các hàng đọc, sao lưu
categories/products đầy đủ trước thay đổi rồi cập nhật revision trong một
transaction. Lỗi ở bất kỳ bước nào sẽ rollback. Có đối chiếu dữ liệu sản phẩm
sau ghi để đảm bảo chỉ `category` và revision được thay đổi. Chạy lại khi dữ liệu
đã chuẩn hóa không ghi thêm, không tạo audit mới hoặc đè bản sao lưu.

Không tự chạy lệnh này mỗi lần server khởi động hoặc seed. Sau này sửa tên/phân
cấp trong admin; lệnh là công cụ bảo trì theo mẫu hiện tại, không được chạy lại
để ghi đè thay đổi thủ công chưa được duyệt. Việc phục hồi từ backup phải kiểm
tra các revision và thay đổi mới trước, không khôi phục mù toàn bộ snapshot.

Database đã cập nhật riêng; việc push code không tự triển khai lên server.
Deploy backend trước frontend để API lọc cha/con hoạt động. Frontend dùng phiên
bản cache catalog mới để không giữ lại dữ liệu phẳng từ bản cũ.

## Kiểm thử

`npm run test:category-tree`: chuỗi cha/con, vòng lặp, độ sâu, ẩn cha,
ánh xạ Fulco, giữ URL, bảo toàn biến thể, idempotency.
`npm run test:category-normalization`: chỉ PostgreSQL local, schema ngẫu nhiên;
kiểm tra preview, backup không ghi đè, quyền file, bảo toàn dữ liệu và audit.
`npm run test:categories`: API thật trên schema QA, lọc cha/con, counts, validation.
Frontend `npm run test:categories`: selector cha, menu cây, form, hàng loạt và mobile.
