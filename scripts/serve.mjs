/**
 * 独立启动服务端，用于「手机浏览器 vs Obsidian」的对比诊断。
 * 如果手机浏览器能打开 http://<ip>:28900/api/ping 而 Obsidian 里不能，
 * 那问题就不在网络，而在 Obsidian 的明文 HTTP 策略。
 *
 * 用法：pnpm serve
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createSyncServer } = require("../dist/server.cjs");

const port = Number(process.env.PORT || 28900);
const token = process.env.TOKEN || "123456";
const uploadDir = path.resolve("dist/uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const handle = await createSyncServer({
  port,
  token,
  uploadDir,
  log: (line) => console.log(`[server] ${line}`),
});

console.log("");
console.log("LAN Sync 测试服务已启动");
console.log(`  配对码：${token}`);
console.log("  地址（手机浏览器可直接访问 /api/ping）：");
for (const url of handle.urls) console.log(`    ${url}/api/ping`);
console.log("");
console.log("按 Ctrl+C 停止。");
