import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 4000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Thư mục dữ liệu
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POSTS_DIR = path.join(ROOT_DIR, 'src', 'content', 'blog');
const DRAFTS_DIR = path.join(ROOT_DIR, 'drafts');
const UPLOADS_DIR = path.join(ROOT_DIR, 'public', 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });
if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Trợ giúp đọc/ghi người dùng
function getUsers() {
	if (!fs.existsSync(USERS_FILE)) return [];
	try {
		return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
	} catch (e) {
		return [];
	}
}

function saveUsers(users) {
	fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// Cấu hình Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Tin cậy proxy nếu đứng sau Nginx
app.set('trust proxy', 1);

// Cấu hình Session
app.use(
	session({
		secret: process.env.SESSION_SECRET || 'goc-mac-dep-fallback-secret-random-32-chars-long',
		resave: false,
		saveUninitialized: false,
		name: '__gmd_admin_sid',
		cookie: {
			httpOnly: true,
			secure: IS_PROD, // Chỉ chạy qua HTTPS khi ở production
			sameSite: 'strict',
			maxAge: 2 * 60 * 60 * 1000, // 2 giờ tự hết hạn
		},
	})
);

// Middleware CSRF nhẹ nhàng nhưng bảo mật tuyệt đối
app.use((req, res, next) => {
	if (!req.session.csrfToken) {
		req.session.csrfToken = crypto.randomBytes(32).toString('hex');
	}
	res.locals.csrfToken = req.session.csrfToken;

	// Bỏ qua xác thực CSRF với các yêu cầu an toàn GET, HEAD, OPTIONS
	if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
		return next();
	}

	// Bỏ qua cho route đăng nhập ban đầu
	if (req.path === '/admin/login') {
		return next();
	}

	const token = req.headers['x-csrf-token'] || req.body._csrf;
	if (!token || token !== req.session.csrfToken) {
		return res.status(403).json({ error: 'Lỗi xác thực bảo mật CSRF Token không hợp lệ.' });
	}
	next();
});

// Giới hạn số lần đăng nhập sai (Brute-force protection)
const loginLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 phút
	max: 5, // Tối đa 5 lần thử
	message: { error: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' },
	standardHeaders: true,
	legacyHeaders: false,
});

// Cấu hình tải file ảnh với Multer & Sharp
const storage = multer.memoryStorage();
const upload = multer({
	storage,
	limits: { fileSize: 5 * 1024 * 1024 }, // Tối đa 5MB
	fileFilter: (req, file, cb) => {
		const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
		if (allowedMimes.includes(file.mimetype)) {
			cb(null, true);
		} else {
			cb(new Error('Chỉ chấp nhận file định dạng ảnh (JPG, PNG, WebP, GIF)!'));
		}
	},
});

// Phục vụ file tĩnh trang admin
app.use('/admin/assets', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Middleware kiểm tra đăng nhập
function requireAuth(req, res, next) {
	if (req.session && req.session.user) {
		return next();
	}
	if (req.xhr || req.headers.accept?.includes('application/json')) {
		return res.status(401).json({ error: 'Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.' });
	}
	res.redirect('/admin/login');
}

// ================= ROUTES =================

// Trang đăng nhập
app.get('/admin/login', (req, res) => {
	if (req.session && req.session.user) {
		return res.redirect('/admin');
	}
	res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// API kiểm tra trạng thái Auth & CSRF
app.get('/admin/api/me', (req, res) => {
	res.json({
		user: req.session.user || null,
		csrfToken: req.session.csrfToken,
	});
});

// Xử lý Đăng nhập (Mật khẩu + OTP 6 số)
app.post('/admin/login', loginLimiter, async (req, res) => {
	const { username, password, otp } = req.body;
	const users = getUsers();
	const user = users.find((u) => u.username === username);

	if (!user) {
		return res.status(400).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
	}

	const isMatch = await bcrypt.compare(password, user.passwordHash);
	if (!isMatch) {
		return res.status(400).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
	}

	// Nếu user đã cấu hình 2FA
	if (user.twoFactorSecret) {
		if (!otp) {
			return res.status(400).json({ error: 'Vui lòng nhập mã xác thực 2 lớp (OTP 6 số).', require2FA: true });
		}
		const verified = speakeasy.totp.verify({
			secret: user.twoFactorSecret,
			encoding: 'base32',
			token: otp.trim(),
			window: 1,
		});
		if (!verified) {
			return res.status(400).json({ error: 'Mã xác thực 2 lớp (OTP) không đúng hoặc đã hết hạn.' });
		}
	}

	// Đăng nhập thành công -> Thiết lập Session
	req.session.user = {
		id: user.id,
		username: user.username,
		role: user.role || 'admin',
		has2FA: !!user.twoFactorSecret,
	};

	res.json({ success: true, redirect: '/admin' });
});

// Đăng xuất
app.post('/admin/logout', (req, res) => {
	req.session.destroy(() => {
		res.json({ success: true, redirect: '/admin/login' });
	});
});

// Giao diện chính Admin (Dashboard & Viết bài)
app.get('/admin', requireAuth, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Tạo mã QR để cài đặt 2FA lần đầu
app.get('/admin/api/2fa/setup', requireAuth, async (req, res) => {
	const users = getUsers();
	const user = users.find((u) => u.username === req.session.user.username);
	if (!user) return res.status(404).json({ error: 'Không tìm thấy người dùng.' });

	const secret = speakeasy.generateSecret({
		name: `GocMacDep (${user.username})`,
		issuer: 'GocMacDep Admin',
	});

	req.session.tempTwoFactorSecret = secret.base32;

	const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url);
	res.json({
		secret: secret.base32,
		qrCode: qrCodeDataUrl,
	});
});

// API: Kích hoạt 2FA
app.post('/admin/api/2fa/enable', requireAuth, (req, res) => {
	const { token } = req.body;
	const tempSecret = req.session.tempTwoFactorSecret;
	if (!tempSecret) {
		return res.status(400).json({ error: 'Không tìm thấy phiên thiết lập 2FA.' });
	}

	const verified = speakeasy.totp.verify({
		secret: tempSecret,
		encoding: 'base32',
		token: token.trim(),
		window: 1,
	});

	if (!verified) {
		return res.status(400).json({ error: 'Mã OTP không hợp lệ. Vui lòng thử lại.' });
	}

	const users = getUsers();
	const user = users.find((u) => u.username === req.session.user.username);
	user.twoFactorSecret = tempSecret;
	saveUsers(users);

	req.session.user.has2FA = true;
	delete req.session.tempTwoFactorSecret;

	res.json({ success: true, message: 'Kích hoạt xác thực 2 lớp thành công!' });
});

// API: Tải lên và tự động nén ảnh (Sharp)
app.post('/admin/api/upload', requireAuth, upload.single('image'), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({ error: 'Vui lòng chọn file ảnh để tải lên.' });
		}

		const timestamp = Date.now();
		const randomStr = crypto.randomBytes(4).toString('hex');
		const originalName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
		const ext = path.extname(originalName).toLowerCase();
		const baseName = path.basename(originalName, ext);
		const filename = `${baseName}-${timestamp}-${randomStr}.webp`;
		const outputPath = path.join(UPLOADS_DIR, filename);

		// Tự động nén và chuyển đổi sang WebP chất lượng cao
		await sharp(req.file.buffer)
			.resize({ width: 1600, withoutEnlargement: true }) // Giữ kích thước tối đa 1600px
			.webp({ quality: 82 })
			.toFile(outputPath);

		const url = `/uploads/${filename}`;
		res.json({ success: true, url, filename });
	} catch (err) {
		res.status(500).json({ error: 'Lỗi khi nén và xử lý ảnh: ' + err.message });
	}
});

// Helper đọc metadata Frontmatter từ file Markdown
function parseMarkdownFile(filepath) {
	const content = fs.readFileSync(filepath, 'utf8');
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };

	const frontmatterStr = match[1];
	const body = match[2];
	const meta = {};

	frontmatterStr.split('\n').forEach((line) => {
		const parts = line.split(':');
		if (parts.length >= 2) {
			const key = parts[0].trim();
			let val = parts.slice(1).join(':').trim();
			// bỏ nháy
			if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
				val = val.substring(1, val.length - 1);
			}
			// mảng
			if (val.startsWith('[') && val.endsWith(']')) {
				try {
					val = val
						.substring(1, val.length - 1)
						.split(',')
						.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
						.filter(Boolean);
				} catch (e) {
					val = [];
				}
			}
			meta[key] = val;
		}
	});

	return { meta, body };
}

// API: Lấy danh sách bài viết (Cả đã xuất bản và nháp)
app.get('/admin/api/posts', requireAuth, (req, res) => {
	const posts = [];

	// Đọc bài đã xuất bản
	if (fs.existsSync(POSTS_DIR)) {
		fs.readdirSync(POSTS_DIR).forEach((file) => {
			if (file.endsWith('.md')) {
				const fullPath = path.join(POSTS_DIR, file);
				const { meta } = parseMarkdownFile(fullPath);
				posts.push({
					slug: file.replace('.md', ''),
					title: meta.title || file,
					pubDate: meta.pubDate || '',
					category: meta.category || '',
					tags: meta.tags || [],
					status: 'published',
				});
			}
		});
	}

	// Đọc bài nháp
	if (fs.existsSync(DRAFTS_DIR)) {
		fs.readdirSync(DRAFTS_DIR).forEach((file) => {
			if (file.endsWith('.json')) {
				try {
					const data = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, file), 'utf8'));
					posts.push({
						slug: file.replace('.json', ''),
						title: data.title || file,
						pubDate: data.updatedAt || data.pubDate || '',
						category: data.category || '',
						tags: data.tags || [],
						status: 'draft',
					});
				} catch (e) {}
			}
		});
	}

	// Sắp xếp bài mới nhất lên đầu
	posts.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
	res.json({ posts });
});

// API: Chi tiết bài viết để sửa
app.get('/admin/api/posts/:slug', requireAuth, (req, res) => {
	const { slug } = req.params;
	const isDraft = req.query.status === 'draft';

	if (isDraft) {
		const draftPath = path.join(DRAFTS_DIR, `${slug}.json`);
		if (!fs.existsSync(draftPath)) return res.status(404).json({ error: 'Không tìm thấy bài nháp.' });
		const data = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
		return res.json({ post: data, status: 'draft' });
	}

	const mdPath = path.join(POSTS_DIR, `${slug}.md`);
	if (!fs.existsSync(mdPath)) return res.status(404).json({ error: 'Không tìm thấy bài viết.' });

	const { meta, body } = parseMarkdownFile(mdPath);
	res.json({
		post: {
			slug,
			title: meta.title || '',
			description: meta.description || '',
			keywords: meta.keywords || '',
			category: meta.category || '',
			tags: Array.isArray(meta.tags) ? meta.tags.join(', ') : meta.tags || '',
			heroImage: meta.heroImage || '',
			content: body.trim(),
			pubDate: meta.pubDate || '',
		},
		status: 'published',
	});
});

// Helper chuyển đổi dữ liệu bài viết sang định dạng file Markdown Frontmatter
function generateMarkdown(postData) {
	const dateStr = postData.pubDate || new Date().toISOString().split('T')[0];
	const tagsArr = (postData.tags || '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);

	const frontmatter = [
		'---',
		`title: '${postData.title.replace(/'/g, "''")}'`,
		`description: '${postData.description.replace(/'/g, "''")}'`,
		`pubDate: ${dateStr}`,
		postData.updatedDate ? `updatedDate: ${postData.updatedDate}` : null,
		postData.heroImage ? `heroImage: '${postData.heroImage}'` : null,
		`tags: [${tagsArr.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')}]`,
		postData.category ? `category: '${postData.category.replace(/'/g, "''")}'` : null,
		postData.keywords ? `keywords: '${postData.keywords.replace(/'/g, "''")}'` : null,
		'---',
		'',
		postData.content,
		'',
	]
		.filter((line) => line !== null)
		.join('\n');

	return frontmatter;
}

// Đẩy file lên GitHub Repo thông qua GitHub REST API
async function commitToGitHub(filePathInRepo, fileContent, commitMessage) {
	const token = process.env.GITHUB_TOKEN;
	const owner = process.env.GITHUB_OWNER;
	const repo = process.env.GITHUB_REPO;
	const branch = process.env.GITHUB_BRANCH || 'main';

	if (!token || !owner || !repo) {
		console.log('GitHub Token hoặc Repo chưa được cấu hình. Bài viết chỉ lưu tại cục bộ.');
		return { localOnly: true };
	}

	const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePathInRepo}`;
	const headers = {
		Authorization: `Bearer ${token}`,
		'User-Agent': 'GocMacDep-Admin-App',
		Accept: 'application/vnd.github.v3+json',
	};

	// 1. Kiểm tra file đã có chưa để lấy SHA nếu sửa bài
	let sha = null;
	try {
		const checkRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
		if (checkRes.ok) {
			const fileData = await checkRes.json();
			sha = fileData.sha;
		}
	} catch (e) {}

	// 2. Tạo hoặc Cập nhật file
	const bodyPayload = {
		message: commitMessage,
		content: Buffer.from(fileContent).toString('base64'),
		branch,
	};
	if (sha) bodyPayload.sha = sha;

	const putRes = await fetch(apiBase, {
		method: 'PUT',
		headers: { ...headers, 'Content-Type': 'application/json' },
		body: JSON.stringify(bodyPayload),
	});

	if (!putRes.ok) {
		const errText = await putRes.text();
		throw new Error(`Lỗi từ GitHub API: ${errText}`);
	}

	return await putRes.json();
}

// API: Lưu nháp bài viết
app.post('/admin/api/drafts', requireAuth, (req, res) => {
	const { slug, title, description, keywords, category, tags, heroImage, content } = req.body;
	if (!slug || !title) {
		return res.status(400).json({ error: 'Slug và Tiêu đề không được để trống.' });
	}

	const draftData = {
		slug,
		title,
		description,
		keywords,
		category,
		tags,
		heroImage,
		content,
		updatedAt: new Date().toISOString(),
	};

	fs.writeFileSync(path.join(DRAFTS_DIR, `${slug}.json`), JSON.stringify(draftData, null, 2), 'utf8');
	res.json({ success: true, message: 'Đã lưu bản nháp thành công!' });
});

// API: Xuất bản bài viết
app.post('/admin/api/publish', requireAuth, async (req, res) => {
	try {
		const { slug, title, description, keywords, category, tags, heroImage, content, pubDate } = req.body;
		if (!slug || !title || !content) {
			return res.status(400).json({ error: 'Tiêu đề, Slug và Nội dung không được để trống.' });
		}

		const postData = {
			slug,
			title,
			description: description || '',
			keywords: keywords || '',
			category: category || '',
			tags: tags || '',
			heroImage: heroImage || '',
			content,
			pubDate: pubDate || new Date().toISOString().split('T')[0],
			updatedDate: new Date().toISOString().split('T')[0],
		};

		const markdownContent = generateMarkdown(postData);
		const mdFilePath = path.join(POSTS_DIR, `${slug}.md`);

		// Lưu cục bộ trên máy chủ
		fs.writeFileSync(mdFilePath, markdownContent, 'utf8');

		// Nếu trước đó có bản nháp trùng slug, xóa bỏ bản nháp
		const draftPath = path.join(DRAFTS_DIR, `${slug}.json`);
		if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);

		// Đẩy lên GitHub để kích hoạt GitHub Actions đưa bài lên blog
		const repoFilePath = `src/content/blog/${slug}.md`;
		const commitMessage = `Publish post: ${title}`;
		const gitHubResult = await commitToGitHub(repoFilePath, markdownContent, commitMessage);

		res.json({
			success: true,
			message: gitHubResult.localOnly
				? 'Đã lưu bài viết vào máy chủ cục bộ (Chưa cấu hình GitHub Token trong .env).'
				: 'Xuất bản và đẩy bài viết lên GitHub thành công! GitHub Actions đang tiến hành triển khai lên blog.',
		});
	} catch (err) {
		res.status(500).json({ error: 'Lỗi khi xuất bản: ' + err.message });
	}
});

// API: Xóa bài viết
app.delete('/admin/api/posts/:slug', requireAuth, async (req, res) => {
	try {
		const { slug } = req.params;
		const { status } = req.query;

		if (status === 'draft') {
			const draftPath = path.join(DRAFTS_DIR, `${slug}.json`);
			if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
			return res.json({ success: true, message: 'Đã xóa bài nháp thành công.' });
		}

		// Xóa bài viết chính thức cục bộ
		const mdPath = path.join(POSTS_DIR, `${slug}.md`);
		if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);

		// Nếu có token GitHub thì thực hiện xóa luôn trên GitHub
		const token = process.env.GITHUB_TOKEN;
		const owner = process.env.GITHUB_OWNER;
		const repo = process.env.GITHUB_REPO;
		const branch = process.env.GITHUB_BRANCH || 'main';

		if (token && owner && repo) {
			const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/src/content/blog/${slug}.md`;
			const headers = {
				Authorization: `Bearer ${token}`,
				'User-Agent': 'GocMacDep-Admin-App',
				Accept: 'application/vnd.github.v3+json',
			};
			const checkRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
			if (checkRes.ok) {
				const fileData = await checkRes.json();
				await fetch(apiBase, {
					method: 'DELETE',
					headers: { ...headers, 'Content-Type': 'application/json' },
					body: JSON.stringify({
						message: `Delete post: ${slug}`,
						sha: fileData.sha,
						branch,
					}),
				});
			}
		}

		res.json({ success: true, message: 'Đã xóa bài viết thành công.' });
	} catch (err) {
		res.status(500).json({ error: 'Lỗi khi xóa bài viết: ' + err.message });
	}
});

// Khởi động Server
app.listen(PORT, () => {
	console.log(`[Admin Server] Đang chạy tại http://localhost:${PORT}/admin`);
	console.log(`[Admin Server] Phiên bản Node: ${process.version} | Môi trường: ${process.env.NODE_ENV || 'development'}`);
});

