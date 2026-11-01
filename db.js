/*
  Xem database bằng tay - dùng DATABASE_URL trong .env (hoặc biến môi trường)

  node db.js                    -> liệt kê toàn bộ phiếu
  node db.js "SELECT ..."       -> chạy câu SQL tuỳ ý
  vd xoá phiếu thử:  node db.js "DELETE FROM rsvps WHERE device_id='test-prod-check-001'"
*/
"use strict";

const fs = require("node:fs");
const path = require("node:path");

(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] !== "" && !(m[1] in process.env)) { process.env[m[1]] = m[2]; }
    }
  } catch (e) { /* không có .env */ }
})();

const URL_DB = process.env.DATABASE_URL || "";
if (!URL_DB) {
  console.error("Chưa có DATABASE_URL. Thêm vào .env dòng:");
  console.error("DATABASE_URL=<External Database URL lấy từ trang database trên Render>");
  process.exit(1);
}

const { Pool } = require("pg");
const host = new URL(URL_DB).hostname;
const pool = new Pool({
  connectionString: URL_DB,
  max: 1,
  ssl: host.includes(".") && host !== "localhost" ? { rejectUnauthorized: false } : false
});

const sql = process.argv[2] ||
  "SELECT name, going, guests + 1 AS so_nguoi, wish, updated_at FROM rsvps ORDER BY updated_at DESC";

pool.query(sql).then((r) => {
  if (Array.isArray(r.rows) && r.rows.length) { console.table(r.rows); }
  else { console.log((r.command || "OK") + " - " + (r.rowCount || 0) + " dòng."); }
  return pool.end();
}).catch((e) => {
  console.error("Lỗi: " + e.message);
  return pool.end().then(() => process.exit(1));
});
