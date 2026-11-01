/*
  Tiện ích thao tác tay với Zalo Bot - tự đọc token/chat id từ .env

  node zalo.js me              -> thông tin bot (kiểm tra token sống)
  node zalo.js id [giây]       -> nghe chờ tin để lấy chat id (mặc định 60s):
                                  chạy lệnh rồi NHẮN CHO BOT trong lúc nó đang nghe
  node zalo.js test [nội dung] -> gửi tin thử tới ZALO_CHAT_ID hiện tại
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

const TOKEN = process.env.ZALO_BOT_TOKEN || "";
const CHAT = process.env.ZALO_CHAT_ID || "";
const API = "https://bot-api.zaloplatforms.com/bot";

if (!TOKEN) {
  console.error("Chưa có ZALO_BOT_TOKEN (đặt trong .env hoặc biến môi trường).");
  process.exit(1);
}

async function call(method, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(API + TOKEN + "/" + method, {
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

const cmd = process.argv[2] || "me";

(async () => {
  if (cmd === "me") {
    console.log(JSON.stringify(await call("getMe", {}, 15000), null, 1));
    return;
  }

  if (cmd === "id") {
    const secs = Math.max(10, Number(process.argv[3]) || 60);
    console.log("Đang nghe " + secs + " giây - NHẮN CHO BOT NGAY BÂY GIỜ");
    console.log("(từ Zalo của người cần lấy id: bạn hoặc chủ thiệp)...");
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) {
      const j = await call("getUpdates", { timeout: 25 }, 35000).catch(() => null);
      if (j && j.ok && j.result && j.result.message) {
        const m = j.result.message;
        console.log("");
        console.log("BẮT ĐƯỢC TIN:");
        console.log("  Người gửi : " + ((m.from && m.from.display_name) || "?"));
        console.log("  Nội dung  : " + (m.text || ""));
        console.log("  chat id   : " + (m.chat && m.chat.id));
        console.log("");
        console.log("-> Dán vào .env (và biến môi trường trên Render):");
        console.log("   ZALO_CHAT_ID=" + (m.chat && m.chat.id));
        return;
      }
      if (j && !j.ok && j.error_code !== 408) {
        console.log("Zalo trả lỗi: " + JSON.stringify(j));
      }
      // 408 = chưa có tin trong cửa sổ vừa rồi -> nghe tiếp
    }
    console.log("Hết giờ, chưa bắt được tin nào. Chạy lại rồi nhắn trong lúc đang nghe nhé.");
    return;
  }

  if (cmd === "test") {
    if (!CHAT) {
      console.error("Chưa có ZALO_CHAT_ID - chạy `node zalo.js id` để lấy trước.");
      process.exit(1);
    }
    const text = process.argv.slice(3).join(" ") ||
      "🎓 Tin thử từ zalo.js - bot hoạt động bình thường!";
    console.log(JSON.stringify(await call("sendMessage", { chat_id: CHAT, text: text.slice(0, 2000) }, 15000), null, 1));
    return;
  }

  console.log("Dùng: node zalo.js me | id [giây] | test [nội dung]");
})().catch((e) => {
  console.error("Lỗi: " + e.message);
  process.exit(1);
});
