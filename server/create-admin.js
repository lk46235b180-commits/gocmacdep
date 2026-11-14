import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
}

const username = process.argv[2] || 'admin';
const password = process.argv[3] || 'Admin@GocMacDep2026!';

async function createAdmin() {
	let users = [];
	if (fs.existsSync(USERS_FILE)) {
		try {
			users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
		} catch (e) {
			users = [];
		}
	}

	const existingIndex = users.findIndex((u) => u.username === username);
	const salt = await bcrypt.genSalt(10);
	const passwordHash = await bcrypt.hash(password, salt);

	const newUser = {
		id: existingIndex >= 0 ? users[existingIndex].id : Date.now().toString(),
		username,
		passwordHash,
		role: 'admin',
		createdAt: new Date().toISOString(),
	};

	if (existingIndex >= 0) {
		users[existingIndex] = { ...users[existingIndex], passwordHash };
		console.log(`Đã cập nhật mật khẩu cho tài khoản: ${username}`);
	} else {
		users.push(newUser);
		console.log(`Đã tạo thành công tài khoản quản trị mới: ${username}`);
	}

	fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
	console.log('--------------------------------------------------');
	console.log(`Tài khoản : ${username}`);
	console.log(`Mật khẩu  : ${password}`);
	console.log('--------------------------------------------------');
	console.log('Bạn có thể đổi mật khẩu bất kỳ lúc nào bằng lệnh:');
	console.log('node server/create-admin.js <username> <mat_khau_moi>');
}

createAdmin().catch(console.error);

