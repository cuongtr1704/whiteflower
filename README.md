# Mẫu thiệp whiteflower

Tông xanh vàng ánh kim, nền trời sao, cuộn phim ảnh chạy liên tục bên cạnh một tấm lớn, tờ lịch đánh dấu ngày bằng bông hoa.

Một trang tĩnh [index.html](index.html), mở bằng nháy đúp là xem được ngay.
[server.js](server.js) lo phần nhận xác nhận của khách, không bắt buộc: không
dựng máy chủ thì thiệp vẫn chạy đủ, chỉ là nút gửi xác nhận rơi về chế độ soạn
sẵn tin nhắn để khách tự gửi Zalo.

## Sửa nội dung

Mở `index.html`, kéo xuống thẻ `<script>` gần cuối file, tìm khối
`/* ================= phần phải điền =================`. Đổi giá trị trong
`CAU_HINH` là xong phần chữ: tên, ngày giờ, địa chỉ, số điện thoại. Chỗ nào
trong trang cần tới thì tự ăn theo, không phải đi tìm sửa từng dòng. Link bản
đồ cũng dựng từ địa chỉ bạn điền.

## Bỏ ảnh vào

Để trong thư mục `anh/`, đặt đúng tên dưới đây. Thiếu tấm nào thì chỗ đó hiện
khung gạch đứt ghi sẵn tên file cần bỏ vào, nên không sợ lạc.

| File | Tỉ lệ | Nằm ở đâu |
|---|---|---|
| `anh/chan-dung.jpg` | 3:4 | ảnh bìa, to nhất trang |
| `anh/01.jpg` | 3:4 | ảnh lớn nằm cạnh cuộn phim |
| `anh/02, 03, 05-09, 14, 15.jpg` | 3:4 | 9 ô cuộn phim chạy liên tục |
| `anh/04.jpg` | 3:4 | cạnh tờ lịch |
| `anh/13.jpg` | 3:4 | cạnh tờ lịch, tấm sau |
| `anh/10.jpg` | 1:1 | album cuối, ô vuông trên |
| `anh/11.jpg` | 1:1 | album cuối, ô vuông dưới |
| `anh/12.jpg` | 2:3 | album cuối, ô dọc cao bên phải |
| `anh/truong.webp` | 16:9 | ảnh ngôi trường, khối chỉ đường |
| `anh/cuoi.jpg` | 3:2 | ảnh khép lại ở chân trang, khung ngang |

Cắt sẵn đúng tỉ lệ trước khi bỏ vào. Để trình duyệt tự cắt thì nó cắt từ giữa,
ảnh chụp cả người hay bị mất đầu hoặc mất chân.

Cạnh dài để khoảng 1400-2000px là vừa. Đừng bỏ thẳng ảnh từ máy ảnh vào: file
20MP trở lên vượt hạn mức giải mã của trình duyệt, nó tự hạ mẫu rồi phóng lại
nên nhìn ra như vỡ, dù file gốc rất nét.

## Nhạc nền

Chép file nhạc vào thư mục gốc, đặt tên `nhac.m4a`. Không có file thì trang vẫn
chạy, chỉ là im.

## Đưa lên mạng

Phần trang tĩnh: đẩy repo lên GitHub rồi nối vào Netlify hoặc Vercel, không cần
cấu hình thêm. `netlify.toml` và `.vercelignore` đã chặn sẵn mấy file của máy chủ.

Phần máy chủ: deploy `server.js` lên Render, rồi dán link đó vào `MAY_CHU` trong
`CAU_HINH`. Chép `.env.example` thành `.env` và điền theo chú thích trong đó.
Bảng khách xem ở `/admin?key=ADMIN_KEY`.

## Đừng đẩy lên repo

`.env` (khoá thật), `data/` (tên và lời chúc của khách), `anh-goc/` (ảnh gốc
chưa nén). Cả ba đã nằm sẵn trong `.gitignore`.
