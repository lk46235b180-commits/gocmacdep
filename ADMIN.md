# Hướng Dẫn Cài Đặt & Triển Khai Blog Lên VPS Ubuntu

Tài liệu này hướng dẫn chi tiết từng bước đưa blog tĩnh Astro **Góc Mặc Đẹp** và ứng dụng Quản trị Node.js (`/admin`) lên máy chủ VPS Ubuntu (20.04/22.04/24.04).

---

## 1. Kiến trúc hệ thống
- **Blog tĩnh:** Được biên dịch thành file HTML/CSS/JS thuần trong thư mục `dist/` và phục vụ bởi **Nginx** với tốc độ tải trang cực nhanh và bảo mật tuyệt đối.
- **Trang quản trị (`/admin`):** Chạy bằng **Node.js (Express)** trên cổng `4000`, đứng sau Reverse Proxy của Nginx với chứng chỉ SSL HTTPS (Let's Encrypt).
- **Tự động hóa:** Khi bạn bấm **Xuất bản** tại `/admin`, ứng dụng Node.js sẽ tự lưu bài Markdown và đẩy commit lên GitHub. **GitHub Actions** tự động biên dịch và đồng bộ file tĩnh mới lên thư mục `/var/www/gocmacdep` của VPS.

---

## 2. Chuẩn bị môi trường trên VPS Ubuntu

### 2.1 Cập nhật hệ thống và cài đặt Nginx, Node.js
Đăng nhập vào VPS qua SSH:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl ufw

# Cài đặt Node.js LTS (v22 hoặc mới hơn)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2.2 Tạo người dùng riêng để chạy ứng dụng (Không dùng root)
Theo tiêu chuẩn an ninh, không chạy ứng dụng bằng quyền `root`:
```bash
# Tạo user riêng tên là 'deployer'
sudo adduser --disabled-password --gecos "" deployer
sudo usermod -aG sudo deployer

# Cấp quyền thư mục web cho deployer
sudo mkdir -p /var/www/gocmacdep
sudo chown -R deployer:deployer /var/www/gocmacdep
```

---

## 3. Cài đặt Ứng dụng Quản trị Node.js trên VPS

### 3.1 Kéo mã nguồn về VPS
Chuyển sang người dùng `deployer`:
```bash
sudo su - deployer
cd /var/www
git clone https://github.com/<tai-khoan>/<ten-repo>.git gocmacdep-admin
cd /var/www/gocmacdep-admin
npm install --omit=dev
```

### 3.2 Thiết lập file bí mật `.env`
Tạo file `.env` từ file mẫu:
```bash
cp .env.example .env
nano .env
```
Điền các giá trị thực tế của bạn:
```env
SESSION_SECRET=chuoi-ngau-nhien-it-nhat-32-ky-tu-bao-mat-cao
PORT=4000
NODE_ENV=production

GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxx
GITHUB_OWNER=tai-khoan-github-cua-ban
GITHUB_REPO=ten-repo-cua-ban
GITHUB_BRANCH=main

SITE_URL=https://thietkewebpro.io.vn
```

### 3.3 Tạo tài khoản Admin đầu tiên
Chạy lệnh tạo tài khoản và mật khẩu an toàn:
```bash
node server/create-admin.js admin MatKhauCuaBan123@!
```

### 3.4 Quản lý tiến trình bằng PM2
Cài đặt PM2 để ứng dụng chạy nền và tự khởi động lại khi reboot VPS:
```bash
sudo npm install -g pm2
pm2 start server/admin.js --name "gocmacdep-admin"
pm2 save
pm2 startup
# Chạy lệnh mà pm2 startup in ra màn hình để hoàn tất cấu hình tự khởi động
```

---

## 4. Cấu hình Nginx & SSL HTTPS miễn phí (Certbot)

### 4.1 Tạo file cấu hình Nginx
Tạo file cấu hình cho tên miền `thietkewebpro.io.vn`:
```bash
sudo nano /etc/nginx/sites-available/thietkewebpro.io.vn
```

Dán nội dung cấu hình sau:
```nginx
server {
    server_name thietkewebpro.io.vn;

    # 1. Thư mục chứa file tĩnh của blog Astro
    root /var/www/gocmacdep;
    index index.html;

    # Cấu hình nén gzip tăng tốc độ tải trang
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

    # Cache tài nguyên tĩnh (ảnh, font, css, js)
    location ~* \.(jpg|jpeg|png|gif|ico|webp|svg|woff|woff2|ttf|css|js)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # 2. Định tuyến cho trang quản trị /admin (Proxy sang Node.js cổng 4000)
    location /admin {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Proxy đường dẫn upload ảnh của admin
    location /uploads {
        alias /var/www/gocmacdep-admin/public/uploads;
        expires 30d;
    }

    # 3. Phục vụ các trang tĩnh Astro và trang lỗi 404
    location / {
        try_files $uri $uri/ /404.html;
    }

    error_page 404 /404.html;
}
```

Kích hoạt cấu hình và kiểm tra:
```bash
sudo ln -s /etc/nginx/sites-available/thietkewebpro.io.vn /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4.2 Cài đặt SSL HTTPS với Certbot Let's Encrypt
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d thietkewebpro.io.vn
```
Certbot sẽ tự động cấu hình HTTPS an toàn cho toàn bộ blog và trang quản trị `/admin`.

---

## 5. Cấu hình GitHub Actions Tự Động Đưa Bài Viết Lên VPS

Vào kho chứa trên GitHub của bạn: **Settings -> Secrets and variables -> Actions -> New repository secret**, thêm các biến sau:

1. `VPS_HOST`: Địa chỉ IP của VPS (ví dụ: `123.45.67.89`).
2. `VPS_USER`: Tên user triển khai (ví dụ: `deployer`).
3. `VPS_SSH_KEY`: Khóa riêng tư SSH (Private Key) để GitHub kết nối vào VPS mà không cần mật khẩu.
4. `VPS_PORT`: Cổng SSH (mặc định là `22`).

Từ bây giờ:
- Khi bạn viết bài trên `/admin` và bấm **Xuất bản**, bài viết tự lưu thành Markdown và đẩy lên GitHub.
- GitHub Actions tự động kích hoạt, build Astro tĩnh và đưa bài viết vào `/var/www/gocmacdep` trong vòng 1-2 phút.

