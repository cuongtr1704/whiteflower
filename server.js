/*
  Máy chủ thiệp tốt nghiệp - Node thuần, KHÔNG cần cài thư viện nào.

  Chạy:        node server.js
  Rồi mở:      http://localhost:3000          (trang thiệp)
               http://localhost:3000/admin?key=KHÓA   (bảng khách cho chủ thiệp)

  Khoá admin KHÔNG viết trong code: đặt biến môi trường ADMIN_KEY (bắt buộc
  khi deploy); không đặt thì mỗi lần khởi động server tự sinh một khoá ngẫu
  nhiên và in ra terminal. Khi chạy sau proxy (Render, Railway...) đặt
  TRUST_PROXY=1 để giới hạn spam tính đúng IP khách thay vì IP của proxy.

  Dữ liệu nằm ở data/rsvps.json - một dòng cho mỗi thiết bị, nên một máy
  bấm bao nhiêu lần cũng chỉ là một phiếu (lần sau ghi đè lần trước).
*/
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/* nạp file .env nếu có - tiện cho máy local; file này bị .gitignore chặn,
   còn trên Render thì đặt biến môi trường trong dashboard.
   Biến môi trường thật luôn thắng giá trị trong .env. */
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] !== "" && !(m[1] in process.env)) { process.env[m[1]] = m[2]; }
    }
  } catch (e) { /* không có .env - bỏ qua */ }
})();

/* ================= cấu hình ================= */
const PORT = Number(process.env.PORT) || 3000;
// tên chủ thiệp, hiện trong bảng khách và vài câu báo lỗi
const TEN = process.env.TEN_CHU_THIEP || "chủ thiệp";
// không có khoá mặc định — thiếu env thì sinh ngẫu nhiên mỗi phiên, in ra terminal
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(12).toString("base64url");
const ADMIN_KEY_GENERATED = !process.env.ADMIN_KEY;
// muối ngẫu nhiên mỗi phiên cho vết băm IP — lộ file dữ liệu cũng không dò ngược được IP
const IP_SALT = crypto.randomBytes(16).toString("hex");

/* ---- Zalo Bot (tùy chọn): báo tin cho chủ thiệp khi có xác nhận mới ----
   Token và chat id CHỈ nằm ở biến môi trường - không bao giờ ở code hay repo. */
const ZALO_BOT_TOKEN = process.env.ZALO_BOT_TOKEN || "";
const ZALO_CHAT_ID = process.env.ZALO_CHAT_ID || "";
const ZALO_API = "https://bot-api.zaloplatforms.com/bot";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const MAX_GUESTS = 2000;         // trần số dòng - chặn phá bằng cách bơm dữ liệu
const MAX_BODY = 8 * 1024;       // thân request tối đa 8KB

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "rsvps.json");

/* ================= kho dữ liệu =================
   Toàn bộ nằm trong RAM, ghi xuống file kiểu nguyên tử
   (ghi file tạm rồi đổi tên) nên không bao giờ hỏng nửa chừng. */
let db = { rsvps: {} }; // khóa là mã thiết bị

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.rsvps !== "object" || Array.isArray(parsed.rsvps)) {
      throw new Error("sai cấu trúc");
    }
    db = parsed;
  } catch (e) {
    if (fs.existsSync(DB_FILE)) {
      const backup = DB_FILE + ".hong-" + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error("File dữ liệu lỗi (" + e.message + "), đã sao lưu sang " + backup);
    }
    db = { rsvps: {} };
  }
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error("Không ghi được dữ liệu:", e.message);
    }
  }, 150);
  ghSave();
}

/* ================= Postgres (khuyên dùng trên Render) =================
   Tạo PostgreSQL free ngay trong Render, dán Internal Database URL vào biến
   DATABASE_URL là xong - server tự tạo bảng, tự nạp lại khi khởi động.
   Không đặt thì rơi về GitHub-repo (bên dưới) hoặc chỉ file local. */
const DATABASE_URL = process.env.DATABASE_URL || "";
let pgPool = null;

async function pgInit() {
  if (!DATABASE_URL) { return; }
  let Pool;
  try {
    Pool = require("pg").Pool;
  } catch (e) {
    console.error("Postgres: thiếu thư viện pg - chạy `npm install` rồi khởi động lại.");
    return;
  }
  try {
    // hostname có dấu chấm = kết nối từ ngoài vào Render -> cần SSL;
    // Internal URL trong cùng Render thì không
    const host = new URL(DATABASE_URL).hostname;
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      ssl: host.includes(".") && host !== "localhost" ? { rejectUnauthorized: false } : false
    });
    await pgPool.query(
      "CREATE TABLE IF NOT EXISTS rsvps (" +
      "device_id text PRIMARY KEY, name text NOT NULL, going text NOT NULL, " +
      "guests int NOT NULL DEFAULT 0, wish text NOT NULL DEFAULT '', " +
      "ip_hash text NOT NULL DEFAULT '', created_at text NOT NULL, updated_at text NOT NULL)"
    );
    const r = await pgPool.query("SELECT * FROM rsvps");
    let them = 0;
    for (const row of r.rows) {
      const v = {
        name: row.name, going: row.going, count: row.guests, wish: row.wish,
        ipHash: row.ip_hash, createdAt: row.created_at, updatedAt: row.updated_at
      };
      const cur = db.rsvps[row.device_id];
      if (!cur || String(v.updatedAt) > String(cur.updatedAt || "")) { db.rsvps[row.device_id] = v; them++; }
    }
    console.log("Postgres: BẬT - nạp " + r.rows.length + " phiếu từ database (gộp " + them + ").");
    saveDb();
  } catch (e) {
    pgPool = null;
    console.error("Postgres: không kết nối được - " + e.message);
  }
}

async function pgUpsert(id, v) {
  if (!pgPool) { return; }
  try {
    await pgPool.query(
      "INSERT INTO rsvps (device_id, name, going, guests, wish, ip_hash, created_at, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
      "ON CONFLICT (device_id) DO UPDATE SET " +
      "name=$2, going=$3, guests=$4, wish=$5, ip_hash=$6, updated_at=$8",
      [id, v.name, v.going, v.count || 0, v.wish || "", v.ipHash || "", v.createdAt, v.updatedAt]
    );
  } catch (e) {
    console.error("Postgres: ghi lỗi - " + e.message);
  }
}

/* ================= lưu bền ra GitHub (dự phòng khi không có DATABASE_URL) =================
   Ổ đĩa Render free là tạm thời: deploy/restart/ngủ-dậy là mất file local.
   Đặt 2 biến môi trường thì dữ liệu sống vĩnh viễn trong repo PRIVATE của bạn:
     GITHUB_TOKEN  - fine-grained PAT, chỉ cấp quyền Contents R/W cho repo đó
     DATA_REPO     - dạng "ten-user/ten-repo-private"
   Khởi động: nạp từ GitHub (gộp theo updatedAt). Mỗi thay đổi: đẩy lên sau 2,5s. */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const DATA_REPO = process.env.DATA_REPO || "";
const DATA_FILE_PATH = process.env.DATA_PATH || "rsvps.json";
let ghSha = null;
let ghTimer = null;
let ghBusy = false;
let ghDirty = false;

function ghEnabled() { return Boolean(GITHUB_TOKEN && DATA_REPO && !DATABASE_URL); }
function ghUrl() { return "https://api.github.com/repos/" + DATA_REPO + "/contents/" + DATA_FILE_PATH; }
function ghHeaders() {
  return {
    "Authorization": "Bearer " + GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "thiep-tot-nghiep",
    "Content-Type": "application/json"
  };
}

async function ghLoad() {
  if (!ghEnabled()) { return; }
  try {
    const r = await fetch(ghUrl(), { headers: ghHeaders() });
    if (r.status === 404) { console.log("GitHub data: chưa có file trên repo, sẽ tạo khi có phiếu đầu tiên."); return; }
    if (!r.ok) { console.error("GitHub data: đọc lỗi HTTP " + r.status); return; }
    const j = await r.json();
    ghSha = j.sha;
    const parsed = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8"));
    if (parsed && typeof parsed.rsvps === "object" && !Array.isArray(parsed.rsvps)) {
      let them = 0;
      for (const [k, v] of Object.entries(parsed.rsvps)) {
        const cur = db.rsvps[k];
        if (!cur || String(v.updatedAt || "") > String(cur.updatedAt || "")) { db.rsvps[k] = v; them++; }
      }
      console.log("GitHub data: đã nạp, gộp " + them + " phiếu (tổng " + Object.keys(db.rsvps).length + ").");
      saveDb();
    }
  } catch (e) {
    console.error("GitHub data: " + e.message);
  }
}

function ghSave() {
  if (!ghEnabled()) { return; }
  ghDirty = true;
  clearTimeout(ghTimer);
  ghTimer = setTimeout(ghPush, 2500);
}

async function ghPush() {
  if (!ghEnabled() || ghBusy) { return; }
  ghBusy = true;
  ghDirty = false;
  try {
    const body = {
      message: "cap nhat danh sach (" + Object.keys(db.rsvps).length + " phieu)",
      content: Buffer.from(JSON.stringify(db, null, 1)).toString("base64")
    };
    if (ghSha) { body.sha = ghSha; }
    let r = await fetch(ghUrl(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) {
      const g = await fetch(ghUrl(), { headers: ghHeaders() });
      if (g.ok) {
        ghSha = (await g.json()).sha;
        body.sha = ghSha;
        r = await fetch(ghUrl(), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
      }
    }
    if (r.ok) {
      ghSha = (await r.json()).content.sha;
    } else {
      console.error("GitHub data: ghi lỗi HTTP " + r.status);
    }
  } catch (e) {
    console.error("GitHub data: " + e.message);
  } finally {
    ghBusy = false;
    if (ghDirty) { ghSave(); }
  }
}

function stats() {
  let co = 0, khong = 0, nguoi = 0;
  for (const r of Object.values(db.rsvps)) {
    if (r.going === "co") { co++; nguoi += 1 + (r.count || 0); }
    else { khong++; }
  }
  return { co, khong, nguoi };
}

/* ================= chặn spam =================
   Cửa sổ trượt theo IP. Mặc định:
   - gửi xác nhận: 5 lần / 10 phút / IP
   - xem thống kê: 30 lần / phút / IP
   - trang admin:  20 lần / phút / IP  */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let arr = hits.get(key) || [];
  arr = arr.filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => { // dọn bộ nhớ đếm mỗi 10 phút
  const now = Date.now();
  for (const [k, arr] of hits) {
    const kept = arr.filter((t) => now - t < 15 * 60 * 1000);
    if (kept.length === 0) { hits.delete(k); } else { hits.set(k, kept); }
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf) { return xf; }
  }
  return req.socket.remoteAddress || "?";
}

/* ================= tiện ích ================= */
function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("qua-lon")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanStr(v, max) {
  if (typeof v !== "string") { return ""; }
  return v.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function safeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/* ================= Zalo Bot ================= */
async function zaloCall(method, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const r = await fetch(ZALO_API + ZALO_BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal
    });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// gửi "bắn rồi quên" - lỗi chỉ ghi log, không bao giờ làm chậm hay hỏng response cho khách
function zaloNotify(text) {
  if (!ZALO_BOT_TOKEN || !ZALO_CHAT_ID) { return; }
  zaloCall("sendMessage", { chat_id: ZALO_CHAT_ID, text: String(text).slice(0, 2000) }, 8000)
    .then((j) => {
      if (!j || !j.ok) { console.error("Zalo bot từ chối:", j && (j.description || j.error_code)); }
    })
    .catch((e) => { console.error("Không gửi được Zalo:", e.message); });
}

// trang cài đặt bot, nằm sau khoá admin:
//   /admin/zalo?key=KHOÁ          -> xem trạng thái + getUpdates để tìm chat id
//   /admin/zalo?key=KHOÁ&test=1   -> gửi tin thử tới ZALO_CHAT_ID
async function handleZaloSetup(u, res, ip) {
  if (limited("admin:" + ip, 20, 60 * 1000)) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Chậm lại nhé.");
  }
  if (!safeEq(u.searchParams.get("key") || "", ADMIN_KEY)) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Sai khoá.");
  }
  let out = "Bot token: " + (ZALO_BOT_TOKEN ? "đã đặt" : "CHƯA đặt (biến môi trường ZALO_BOT_TOKEN)") + "\n" +
            "Chat id:   " + (ZALO_CHAT_ID || "CHƯA đặt (biến môi trường ZALO_CHAT_ID)") + "\n\n";
  if (ZALO_BOT_TOKEN) {
    try {
      if (u.searchParams.get("test") === "1") {
        const t = await zaloCall("sendMessage",
          { chat_id: ZALO_CHAT_ID, text: "🎓 Tin thử từ thiệp tốt nghiệp - bot hoạt động!" }, 10000);
        out += "Kết quả gửi thử:\n" + JSON.stringify(t, null, 1) + "\n";
      } else {
        const j = await zaloCall("getUpdates", { timeout: 20 }, 28000);
        out += "getUpdates - tìm chat id trong message.chat.id\n" +
               "TRANG NÀY CHỈ NGHE ĐƯỢC TIN ĐẾN TRONG ~20 GIÂY LÚC ĐANG TẢI:\n" +
               "bấm F5 rồi NHẮN CHO BOT NGAY trong lúc trang đang quay.\n" +
               "408 = lỡ nhịp (tin gửi trước/sau lúc nghe) - F5 và nhắn lại.\n" +
               JSON.stringify(j, null, 1) + "\n";
      }
    } catch (e) {
      out += "Lỗi gọi Zalo: " + e.message + "\n";
    }
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(out);
}

/* ================= API ================= */
async function handleRsvp(req, res, ip) {
  if (limited("post:" + ip, 5, 10 * 60 * 1000)) {
    return send(res, 429, { ok: false, error: "Bạn gửi nhanh quá, đợi vài phút rồi thử lại nhé." });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_BODY));
  } catch (e) {
    return send(res, 400, { ok: false, error: "Dữ liệu không đọc được." });
  }
  const deviceId = cleanStr(body.deviceId, 100);
  const name = cleanStr(body.name, 80);
  const going = body.going === "khong" ? "khong" : body.going === "co" ? "co" : null;
  const count = Number.isInteger(body.count) && body.count >= 0 && body.count <= 3 ? body.count : 0;
  const wish = cleanStr(body.wish, 300);

  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) { return send(res, 400, { ok: false, error: "Thiếu mã thiết bị." }); }
  if (!name) { return send(res, 400, { ok: false, error: "Bạn điền tên giúp mình nhé." }); }
  if (!going) { return send(res, 400, { ok: false, error: "Thiếu lựa chọn có/không." }); }

  const existed = Object.prototype.hasOwnProperty.call(db.rsvps, deviceId);
  if (!existed && Object.keys(db.rsvps).length >= MAX_GUESTS) {
    return send(res, 503, { ok: false, error: `Danh sách tạm đầy, bạn nhắn trực tiếp cho ${TEN} nhé.` });
  }

  const now = new Date().toISOString();
  db.rsvps[deviceId] = {
    name, going, count, wish,
    // chỉ lưu vết băm IP (12 ký tự) để truy spam, không lưu IP thật
    ipHash: crypto.createHash("sha256").update(IP_SALT + ip).digest("hex").slice(0, 12),
    createdAt: existed ? db.rsvps[deviceId].createdAt : now,
    updatedAt: now
  };
  saveDb();
  await pgUpsert(deviceId, db.rsvps[deviceId]);
  const after = stats();
  zaloNotify(
    (existed ? "✏️ Cập nhật xác nhận" : "🎓 Xác nhận mới") + "\n" +
    "Tên: " + name + "\n" +
    (going === "co" ? "Tham dự: CÓ" : "Tham dự: không đến được") +
    (wish ? "\nLời chúc: " + wish : "") +
    "\n----\nTổng hiện tại: " + after.co + " bạn sẽ đến / " + after.khong + " bạn không đến được"
  );
  send(res, 200, { ok: true, updated: existed, stats: after });
}

/* ================= trang admin ================= */
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
  } catch (e) { return iso || ""; }
}

/* Một ô CSV. Hai thứ phải canh:
   - Dấu phẩy, dấu nháy kép và xuống dòng phải được bọc lại, không thì lệch cột.
   - Ô mở đầu bằng = + - @ bị Excel và Google Sheets hiểu là công thức. Lời nhắn
     là do khách tự gõ nên phải chặn, thêm dấu nháy đơn ở đầu cho nó thành chữ. */
function csvO(v) {
  let t = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) { t = "'" + t; }
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/* Tải danh sách khách về máy, mở được bằng Excel lẫn Google Sheets. */
function handleExport(u, res, ip) {
  if (limited("export:" + ip, 10, 60 * 1000)) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Chậm lại nhé.");
  }
  if (!safeEq(u.searchParams.get("key") || "", ADMIN_KEY)) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Sai khóa.");
  }

  const cot = ["Tên khách", "Sẽ đến", "Số người", "Lời nhắn", "Gửi lúc", "Mã thiết bị"];
  const dong = Object.entries(db.rsvps)
    .sort((a, b) => String(b[1].updatedAt || "").localeCompare(String(a[1].updatedAt || "")))
    .map(([id, r]) => [
      r.name,
      r.going === "co" ? "Có" : "Không",
      r.going === "co" ? (r.count || 1) : 0,
      r.wish || "",
      fmtTime(r.updatedAt),
      String(id).slice(0, 8)
    ].map(csvO).join(","));

  /* \uFEFF là dấu nhận dạng UTF-8. Thiếu nó là Excel đọc tiếng Việt ra ký tự lạ. */
  const csv = "\uFEFF" + [cot.map(csvO).join(",")].concat(dong).join("\r\n") + "\r\n";
  const ngay = new Date().toISOString().slice(0, 10);

  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="khach-moi-' + ngay + '.csv"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(csv);
}

function handleAdmin(u, res, ip) {
  if (limited("admin:" + ip, 20, 60 * 1000)) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Chậm lại nhé.");
  }
  if (!safeEq(u.searchParams.get("key") || "", ADMIN_KEY)) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    return res.end('<p style="font-family:sans-serif;padding:24px">Sai khóa. Khoá nằm trong biến môi trường ADMIN_KEY, hoặc xem dòng in ra terminal lúc khởi động server.</p>');
  }
  const s = stats();
  const rows = Object.entries(db.rsvps)
    .sort((a, b) => String(b[1].updatedAt || "").localeCompare(String(a[1].updatedAt || "")))
    .map(([id, r]) =>
      "<tr><td>" + esc(r.name) +
      "</td><td>" + (r.going === "co" ? "Có ✓" : "Không ✗") +
      "</td><td>" + esc(r.wish || "") +
      "</td><td>" + esc(fmtTime(r.updatedAt)) +
      "</td><td style='opacity:.45'>" + esc(String(id).slice(0, 8)) + "…</td></tr>"
    ).join("");
  const html = "<!doctype html><html lang='vi'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    `<title>Khách mời - Thiệp ${TEN}</title><style>` +
    "body{font-family:'Segoe UI',system-ui,sans-serif;background:#0B1028;color:#EFEAF6;margin:0;padding:24px}" +
    "h1{font-weight:500;font-size:1.3rem}" +
    ".tot{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0 26px}" +
    ".tot div{background:#131939;border:1px solid rgba(245,217,143,.25);padding:14px 22px}" +
    ".tot b{display:block;font-size:2rem;color:#F5D98F}" +
    ".tot span{font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:#ADA6CC}" +
    "table{border-collapse:collapse;width:100%;max-width:980px}" +
    "th,td{border-bottom:1px solid rgba(245,217,143,.16);padding:9px 12px;text-align:left;font-size:.92rem;vertical-align:top}" +
    "th{color:#C9BA90;font-weight:500;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase}" +
    ".tai{display:inline-block;border:1px solid rgba(245,217,143,.5);color:#F5D98F;text-decoration:none;" +
    "padding:10px 20px;font-size:.84rem;letter-spacing:.08em}" +
    ".tai:hover{background:rgba(245,217,143,.12)}" +
    "</style></head><body>" +
    "<h1>Khách xác nhận dự lễ tốt nghiệp</h1>" +
    "<div class='tot'>" +
    "<div><b>" + s.co + "</b><span>bạn sẽ đến</span></div>" +
    "<div><b>" + s.khong + "</b><span>bạn bận, không đến</span></div>" +
    "</div>" +
    "<p style='margin:-10px 0 24px'><a class='tai' href='/admin/export.csv?key=" +
      encodeURIComponent(u.searchParams.get("key") || "") + "'>Tải danh sách về (file bảng tính)</a></p>" +
    "<table><thead><tr><th>Tên</th><th>Đến?</th><th>Lời chúc</th><th>Lúc</th><th>Thiết bị</th></tr></thead>" +
    "<tbody>" + (rows || "<tr><td colspan='5' style='color:#ADA6CC'>Chưa có ai xác nhận.</td></tr>") + "</tbody></table>" +
    "</body></html>";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

/* ================= file tĩnh =================
   Chỉ phục vụ đúng index.html và ảnh trong anh/ - không bao giờ
   lộ server.js hay thư mục data/. */
function sendFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Khong tim thay");
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

function serveStatic(p, res) {
  if (p === "/" || p === "/index.html") {
    return sendFile(res, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
  }
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
  const au = p.match(/^\/([A-Za-z0-9_][A-Za-z0-9_-]*\.(m4a|mp3|ogg))$/i);
  if (au) {
    const aTypes = { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg" };
    return sendFile(res, path.join(ROOT, au[1]), aTypes[au[2].toLowerCase()]);
  }
  const m = p.match(/^\/anh\/([A-Za-z0-9_][A-Za-z0-9_.-]*\.(jpe?g|png|webp|gif))$/i);
  if (m) {
    const types = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    const ext = m[2].toLowerCase() === "jpeg" ? "jpeg" : m[2].toLowerCase();
    return sendFile(res, path.join(ROOT, "anh", m[1]), types[ext] || "application/octet-stream");
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Khong tim thay");
}

/* ================= khởi động ================= */
const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let u;
  try { u = new URL(req.url, "http://local"); } catch (e) { return send(res, 400, { ok: false }); }
  const p = u.pathname;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      });
      return res.end();
    }
    if (p === "/api/rsvp" && req.method === "POST") { return await handleRsvp(req, res, ip); }
    if (p === "/api/health" && req.method === "GET") {
      if (limited("health:" + ip, 120, 60 * 1000)) { return send(res, 429, { ok: false }); }
      return send(res, 200, { ok: true });
    }
    if (p === "/api/stats" && req.method === "GET") {
      if (limited("stats:" + ip, 30, 60 * 1000)) { return send(res, 429, { ok: false }); }
      return send(res, 200, { ok: true, stats: stats() });
    }
    if (p === "/admin/zalo" && req.method === "GET") { return await handleZaloSetup(u, res, ip); }
    if (p === "/admin/export.csv" && req.method === "GET") { return handleExport(u, res, ip); }
    if (p === "/admin" && req.method === "GET") { return handleAdmin(u, res, ip); }
    if (req.method === "GET" || req.method === "HEAD") { return serveStatic(p, res); }
    send(res, 404, { ok: false });
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: "Lỗi máy chủ." });
  }
});

loadDb();
if (DATABASE_URL) { pgInit(); } else { ghLoad(); }
server.listen(PORT, () => {
  console.log("Thiệp đang chạy:   http://localhost:" + PORT);
  console.log("Bảng khách (admin): http://localhost:" + PORT + "/admin?key=" + ADMIN_KEY);
  if (ADMIN_KEY_GENERATED) {
    console.log("(Khoá admin trên sinh ngẫu nhiên cho phiên này. Đặt biến môi trường ADMIN_KEY để dùng khoá cố định.)");
  }
  console.log(
    ZALO_BOT_TOKEN && ZALO_CHAT_ID
      ? "Zalo Bot: BẬT - mỗi xác nhận mới sẽ nhắn về Zalo."
      : "Zalo Bot: tắt (đặt ZALO_BOT_TOKEN và ZALO_CHAT_ID để bật; xem /admin/zalo)."
  );
  console.log(
    DATABASE_URL
      ? "Dữ liệu: Postgres (DATABASE_URL) - sống qua deploy/restart/ngủ-dậy."
      : ghEnabled()
        ? "Dữ liệu: repo GitHub " + DATA_REPO + " - sống qua deploy/restart."
        : "Dữ liệu: CHỈ file local - TRÊN RENDER SẼ MẤT mỗi lần deploy/ngủ dậy! Đặt DATABASE_URL (xem README)."
  );
  console.log("Dữ liệu lưu ở:      " + DB_FILE);
});
