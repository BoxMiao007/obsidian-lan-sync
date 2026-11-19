/**
 * LAN Sync —— 桌面端 HTTP 服务（spike 版，后续复用为正式协议服务端）
 *
 * 设计约束（很重要，别改坏）：
 * 1. 手机端 Obsidian 是 Capacitor WebView，没有 Node，因此服务端只能跑在桌面端。
 * 2. 本文件不用顶层 import 引入任何 Node 模块，全部在函数内部 require()。
 *    否则 esbuild 会把 require("http") 提升到 main.js 顶部，手机端加载即抛错，插件整个失效。
 * 3. 协议只做纯 HTTP，不依赖任何云、不依赖 WebSocket（手机端可发出站请求，但收不了入站连接）。
 */

declare const require: (id: string) => any;

import { isIgnored, type IgnoreConfig } from "./core/ignore";
import { detectConflictMarkers } from "./core/conflict-markers";
import type { FileEntry, Manifest } from "./core/types";

export interface SyncServerOptions {
  /** 期望端口，被占用时自动往后顺延 */
  port: number;
  /** 配对码 / 请求令牌 */
  token: string;
  /** 上传落盘目录（必须位于库内，手机端看不到库外路径） */
  uploadDir: string;
  /** 本插件在电脑上的绝对目录，用于给手机端提供安装文件下载 */
  pluginDir?: string;
  /** 要被同步的库根目录（绝对路径）；不传则 /api/v1 不可用 */
  vaultDir?: string;
  /** 与服务端一致的忽略规则 */
  ignore?: IgnoreConfig;
  log?: (line: string) => void;
}

export interface ServerAddress {
  /** 网卡名，例如 WLAN / 以太网 / VMware Network Adapter */
  name: string;
  address: string;
  url: string;
}

export interface SyncServerHandle {
  port: number;
  urls: string[];
  addresses: ServerAddress[];
  close: () => Promise<void>;
}

/** 单次请求体上限，4MB 分块 + 余量 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_MB = 64;
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
const PORT_ATTEMPTS = 20;
const SAFE_PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
const INSTALL_NOTE = `LAN Sync · 手机安装说明

1. 解压后得到 main.js、manifest.json、styles.css
2. 把这三个文件放进 Obsidian 库的 .obsidian/plugins/lan-sync/ 目录
   （没有 lan-sync 文件夹就新建，三个文件必须平铺在里面）
3. 完全退出 Obsidian 再打开
4. 设置 → 第三方插件 → 启用「LAN Sync · 局域网同步」
5. 在插件设置里填电脑 IP、端口、配对码，先点「完整自检」
`;

interface UploadState {
  path: string;
  size: number;
  received: number;
}

export async function createSyncServer(opts: SyncServerOptions): Promise<SyncServerHandle> {
  const http = require("http");
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");

  const log = opts.log ?? (() => {});
  const uploads = new Map<string, UploadState>();
  const v1Uploads = new Map<string, { path: string; size: number; sha256: string | null; received: number }>();
  let activeSession: { id: string; startedAt: number } | null = null;
  const SESSION_TTL_MS = 60 * 60 * 1000;
  const blobCache = new Map<string, any>();

  const uploadRoot = path.join(opts.uploadDir, "spike-uploads");
  fs.mkdirSync(uploadRoot, { recursive: true });

  const ignoreConfig: IgnoreConfig =
    opts.ignore ?? { configDir: ".obsidian", selfPluginId: "lan-sync" };

  const sha256 = (buf: any): string => crypto.createHash("sha256").update(buf).digest("hex");

  /** 服务端清单缓存：path -> 大小/mtime/哈希/是否含冲突标记，未变则复用 */
  const manifestCache = new Map<
    string,
    { size: number; mtime: number; sha256: string | null; unsafe: boolean }
  >();

  const hashFile = async (absPath: string, size: number): Promise<string | null> => {
    try {
      if (size <= 24 * 1024 * 1024) {
        return sha256(fs.readFileSync(absPath));
      }
      return await new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(absPath);
        stream.on("data", (chunk: any) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
      });
    } catch {
      return null;
    }
  };

  const listVaultFiles = (): string[] => {
    const root: string = opts.vaultDir as string;
    const out: string[] = [];
    const walk = (rel: string) => {
      const abs = rel ? path.join(root, rel) : root;
      let entries: any[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (isIgnored(childRel, ignoreConfig)) continue;
        if (ent.isDirectory()) walk(childRel);
        else if (ent.isFile()) out.push(childRel);
      }
    };
    walk("");
    return out.sort();
  };

  const buildServerManifest = async (): Promise<Manifest> => {
    const entries: FileEntry[] = [];
    for (const rel of listVaultFiles()) {
      const abs = path.join(opts.vaultDir as string, rel);
      let stat: any;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const size = stat.size;
      const mtime = Math.trunc(stat.mtimeMs || 0);
      const cached = manifestCache.get(rel);
      let hash: string | null;
      let unsafe = false;
      if (cached && cached.size === size && cached.mtime === mtime) {
        hash = cached.sha256;
        unsafe = cached.unsafe;
      } else if (size <= 24 * 1024 * 1024) {
        // 小文件一次读入：哈希与「冲突标记」检测共用同一份内容
        try {
          const buffer = fs.readFileSync(abs);
          hash = sha256(buffer);
          unsafe = detectConflictMarkers(buffer);
        } catch {
          hash = null;
        }
        manifestCache.set(rel, { size, mtime, sha256: hash, unsafe });
      } else {
        hash = await hashFile(abs, size);
        manifestCache.set(rel, { size, mtime, sha256: hash, unsafe });
      }
      entries.push({ path: rel, size, mtime, sha256: hash, unsafe });
    }
    return { generatedAt: Date.now(), entries };
  };

  /** 最小 ZIP 打包（仅 store，无压缩）：手机端一次下载三个文件，省得逐个点。 */
function buildZip(files: Array<{ name: string; data: any }>): any {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: any): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const locals: any[] = [];
  const centrals: any[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = file.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBlob.length, 12);
  end.writeUInt32LE(localBlob.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localBlob, centralBlob, end]);
}

const resolveVaultFile = (relPath: string): string | null => {
    const root: string = opts.vaultDir as string;
    const normalized = String(relPath || "").replace(/\\/g, "/");
    if (!normalized || normalized.includes("..") || normalized.startsWith("/")) return null;
    const abs = path.resolve(root, normalized);
    const rootAbs = path.resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
    return abs;
  };


  const getBlob = (mb: number): any => {
    const key = String(mb);
    let buf = blobCache.get(key);
    if (!buf) {
      buf = Buffer.allocUnsafe(mb * 1024 * 1024);
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
      blobCache.set(key, buf);
    }
    return buf;
  };

  const readBody = (req: any, limit: number): Promise<any> =>
    new Promise((resolve, reject) => {
      const parts: any[] = [];
      let total = 0;
      req.on("data", (chunk: any) => {
        total += chunk.length;
        if (total > limit) {
          reject(new Error(`请求体超过上限 ${limit} 字节`));
          req.destroy();
          return;
        }
        parts.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(parts)));
      req.on("error", reject);
    });

  const server = http.createServer((req: any, res: any) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const startedAt = Date.now();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Cache-Control", "no-store");

    const sendJson = (status: number, obj: any) => {
      const body = Buffer.from(JSON.stringify(obj), "utf8");
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", String(body.length));
      res.end(body);
    };

    const authorized = (): boolean => {
      const queryToken = url.searchParams.get("token") || "";
      const got = String(req.headers["x-lan-sync-token"] || queryToken);
      if (!got || got.length !== opts.token.length) return false;
      try {
        return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(opts.token));
      } catch {
        return false;
      }
    };

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    void (async () => {
      try {
        // 健康检查：不要求令牌，方便手机端先判断「网络是否通」。
        if (pathname === "/api/ping") {
          sendJson(200, {
            ok: true,
            app: "lan-sync",
            mode: "spike",
            platform: "desktop",
            time: Date.now(),
            uptimeSeconds: Math.round(process.uptime()),
          });
          return;
        }

        // 手机浏览器打开这里：既证明「浏览器能连上电脑」，也直接下载插件三件套。
        if (pathname === "/" && req.method === "GET") {
          const token = url.searchParams.get("token") || "";
          const fileLinks = ["main.js", "manifest.json", "styles.css"]
            .map((name) => `<li><a href="/install/file?name=${name}&token=${encodeURIComponent(token)}">${name}</a></li>`)
            .join("");
          const zipLink = `<p><a class="zip" href="/install/all.zip?token=${encodeURIComponent(token)}">⬇ 一次下载全部（lan-sync.zip）</a></p>`;
          const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAN Sync 安装</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;line-height:1.6;max-width:720px}
code{background:#eee;padding:2px 4px;border-radius:3px}a{color:#2563eb}
a.zip{display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600}
#result{font-weight:600}</style></head>
<body>
<h1>LAN Sync · 手机安装助手</h1>
<p>能看到这一页，说明手机浏览器已经能访问这台电脑（${port}）。</p>
<p><button id="test">测试 /api/ping</button> <span id="result">未测试</span></p>
<h2>下载插件文件</h2>
<p>当前页面链接里的配对码：<code>${token ? "已带上" : "缺失，请从电脑设置页复制完整链接"}</code></p>
${zipLink}
<p>或者逐个下载：</p>
<ul>${fileLinks}</ul>
<h2>安装步骤</h2>
<ol>
<li>把下载到的文件（推荐用上面的 zip）解压到手机。</li>
<li>用手机文件管理器把它们放进 Obsidian 库的 <code>.obsidian/plugins/lan-sync/</code> 目录（没有就新建）。</li>
<li>重启 Obsidian → 设置 → 第三方插件 → 启用「LAN Sync · 局域网同步」。</li>
<li>在插件设置里填电脑 IP、端口、配对码，点「完整自检」。</li>
</ol>
<script>
document.getElementById("test").addEventListener("click", async () => {
  const el = document.getElementById("result");
  el.textContent = "测试中…";
  try {
    const t0 = Date.now();
    const r = await fetch("/api/ping");
    const j = await r.json();
    el.textContent = "成功：" + j.app + " @ " + j.platform + "，" + (Date.now()-t0) + "ms";
    el.style.color = "green";
  } catch (e) {
    el.textContent = "失败：" + e;
    el.style.color = "red";
  }
});
</script>
</body></html>`;
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(Buffer.from(html, "utf8"));
          return;
        }

        if (pathname === "/install/all.zip" && req.method === "GET") {
          if (!authorized()) {
            sendJson(401, { ok: false, error: "配对码不正确" });
            return;
          }
          if (!opts.pluginDir) {
            sendJson(404, { ok: false, error: "无法定位插件目录" });
            return;
          }
          const files: Array<{ name: string; data: any }> = [];
          for (const name of SAFE_PLUGIN_FILES) {
            const filePath = path.join(opts.pluginDir, name);
            if (!fs.existsSync(filePath)) continue;
            files.push({ name, data: fs.readFileSync(filePath) });
          }
          files.push({ name: "安装说明.txt", data: Buffer.from(INSTALL_NOTE, "utf8") });
          const zip = buildZip(files);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/zip");
          res.setHeader("Content-Length", String(zip.length));
          res.setHeader("Content-Disposition", 'attachment; filename="lan-sync.zip"');
          res.end(zip);
          return;
        }

        if (pathname === "/install/file" && req.method === "GET") {
          if (!authorized()) {
            sendJson(401, { ok: false, error: "配对码不正确" });
            return;
          }
          const name = url.searchParams.get("name") || "";
          if (!SAFE_PLUGIN_FILES.includes(name) || !opts.pluginDir) {
            sendJson(404, { ok: false, error: "文件不存在" });
            return;
          }
          const filePath = path.join(opts.pluginDir, name);
          if (!fs.existsSync(filePath)) {
            sendJson(404, { ok: false, error: "文件不存在" });
            return;
          }
          const data = fs.readFileSync(filePath);
          const type = name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : name.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "text/css; charset=utf-8";
          res.statusCode = 200;
          res.setHeader("Content-Type", type);
          res.setHeader("Content-Length", String(data.length));
          res.end(data);
          return;
        }

        if (!authorized()) {
          sendJson(401, { ok: false, error: "配对码不正确" });
          return;
        }

        // ===== v1 同步协议 =====
        if (pathname === "/api/v1/session/start" && req.method === "POST") {
          if (activeSession && Date.now() - activeSession.startedAt < SESSION_TTL_MS) {
            sendJson(409, { ok: false, error: "另一台设备正在同步，请稍后再试" });
            return;
          }
          const id = crypto.randomBytes(8).toString("hex");
          activeSession = { id, startedAt: Date.now() };
          sendJson(200, { ok: true, sessionId: id });
          return;
        }

        if (pathname === "/api/v1/session/end" && req.method === "POST") {
          const id = url.searchParams.get("sessionId") || req.headers["x-lan-sync-session"] || "";
          if (activeSession && activeSession.id === id) activeSession = null;
          sendJson(200, { ok: true });
          return;
        }

        // 其余 v1 接口都要求持有一个有效会话，保证同一时刻只有一个客户端在同步
        const requireSession = () => {
          const id = String(req.headers["x-lan-sync-session"] || "");
          if (!activeSession || activeSession.id !== id) {
            const error: any = new Error("同步会话无效或已过期，请重新开始同步");
            error.statusCode = 409;
            throw error;
          }
        };

        if (pathname === "/api/v1/manifest" && req.method === "GET") {
          requireSession();
          if (!opts.vaultDir) throw new Error("服务端未配置 vaultDir");
          const manifest = await buildServerManifest();
          sendJson(200, { ok: true, ...manifest });
          return;
        }

        if (pathname === "/api/v1/file" && req.method === "GET") {
          requireSession();
          if (!opts.vaultDir) throw new Error("服务端未配置 vaultDir");
          const abs = resolveVaultFile(url.searchParams.get("path") || "");
          if (!abs) throw new Error("路径不合法");
          if (!fs.existsSync(abs)) {
            sendJson(404, { ok: false, error: "文件不存在" });
            return;
          }
          const stat = fs.statSync(abs);
          if (!stat.isFile()) throw new Error("不是文件");
          const size = stat.size;
          const offset = clampInt(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0, size);
          const lenRaw = parseInt(url.searchParams.get("len") || "", 10);
          const len = Number.isFinite(lenRaw) && lenRaw > 0
            ? Math.min(lenRaw, size - offset)
            : size - offset;

          const buffer = Buffer.alloc(len);
          if (len > 0) {
            const fd = fs.openSync(abs, "r");
            try {
              fs.readSync(fd, buffer, 0, len, offset);
            } finally {
              fs.closeSync(fd);
            }
          }
          const cached = manifestCache.get(String(url.searchParams.get("path") || ""));
          const fileSha =
            cached && cached.size === size && cached.mtime === Math.trunc(stat.mtimeMs || 0)
              ? cached.sha256
              : null;

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Length", String(buffer.length));
          res.setHeader("x-file-size", String(size));
          res.setHeader("x-chunk-sha256", sha256(buffer));
          if (fileSha) res.setHeader("x-file-sha256", fileSha);
          res.end(buffer);
          return;
        }

        // 手机 → 电脑上传：先写临时文件，校验通过后原子替换目标
        if (pathname === "/api/v1/upload/init" && req.method === "POST") {
          requireSession();
          if (!opts.vaultDir) throw new Error("服务端未配置 vaultDir");
          const body = await readBody(req, 64 * 1024);
          const info = JSON.parse(body.toString("utf8") || "{}");
          const rel = String(info.path || "").replace(/\\/g, "/");
          if (!rel || rel.includes("..") || isIgnored(rel, ignoreConfig)) {
            throw new Error("目标路径不合法");
          }
          const size = Number(info.size) || 0;
          if (size < 0 || size > 128 * 1024 * 1024) throw new Error("文件大小不合法");
          const id = crypto.randomBytes(8).toString("hex");
          const tmpPath = path.join(uploadRoot, `v1-${id}.part`);
          fs.writeFileSync(tmpPath, Buffer.alloc(0));
          v1Uploads.set(id, {
            path: rel,
            size,
            sha256: info.sha256 ? String(info.sha256) : null,
            received: 0,
          });
          sendJson(200, { ok: true, uploadId: id });
          return;
        }

        if (pathname === "/api/v1/upload/chunk" && req.method === "POST") {
          requireSession();
          const id = url.searchParams.get("uploadId") || "";
          const state = v1Uploads.get(id);
          if (!state) throw new Error("uploadId 不存在");
          const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
          const body = await readBody(req, MAX_BODY_BYTES);
          const tmpPath = path.join(uploadRoot, `v1-${id}.part`);
          const fd = fs.openSync(tmpPath, "r+");
          try {
            fs.writeSync(fd, body, 0, body.length, offset);
          } finally {
            fs.closeSync(fd);
          }
          state.received += body.length;
          sendJson(200, { ok: true, received: body.length, offset });
          return;
        }

        if (pathname === "/api/v1/upload/finish" && req.method === "POST") {
          requireSession();
          if (!opts.vaultDir) throw new Error("服务端未配置 vaultDir");
          const id = url.searchParams.get("uploadId") || "";
          const state = v1Uploads.get(id);
          if (!state) throw new Error("uploadId 不存在");
          const tmpPath = path.join(uploadRoot, `v1-${id}.part`);
          const data = fs.readFileSync(tmpPath);
          if (data.length !== state.size) throw new Error(`上传大小不符：${data.length}/${state.size}`);
          const digest = sha256(data);
          if (state.sha256 && digest !== state.sha256) throw new Error("上传内容哈希不一致");
          const abs = resolveVaultFile(state.path);
          if (!abs) throw new Error("目标路径不合法");
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          const replaceTmp = path.join(uploadRoot, `v1-${id}.replace`);
          fs.writeFileSync(replaceTmp, data);
          try {
            fs.rmSync(abs, { force: true });
          } catch {
            /* 目标不存在 */
          }
          fs.renameSync(replaceTmp, abs);
          fs.rmSync(tmpPath, { force: true });
          manifestCache.delete(state.path);
          const stat = fs.statSync(abs);
          v1Uploads.delete(id);
          sendJson(200, {
            ok: true,
            entry: {
              path: state.path,
              size: stat.size,
              mtime: Math.trunc(stat.mtimeMs || 0),
              sha256: digest,
            },
          });
          return;
        }

        if (pathname === "/api/v1/file" && req.method === "DELETE") {
          requireSession();
          if (!opts.vaultDir) throw new Error("服务端未配置 vaultDir");
          const rel = url.searchParams.get("path") || "";
          if (!rel || rel.includes("..") || isIgnored(rel, ignoreConfig)) throw new Error("路径不合法");
          const abs = resolveVaultFile(rel);
          if (!abs) throw new Error("路径不合法");
          fs.rmSync(abs, { force: true });
          manifestCache.delete(rel);
          sendJson(200, { ok: true, path: rel });
          return;
        }

        // 覆盖/删除前把电脑端文件复制到 .trash（备份目录本身被同步忽略）
        if (pathname === "/api/v1/backup" && req.method === "POST") {
          requireSession();
          if (!opts.vaultDir) throw new Error("服务端未配置 vaultDir");
          const body = await readBody(req, 1024 * 1024);
          const info = JSON.parse(body.toString("utf8") || "{}");
          const folder = String(info.folder || "").replace(/\\/g, "/");
          if (!folder.startsWith(".trash/") || folder.includes("..")) {
            throw new Error("备份目录不合法");
          }
          const folderAbs = resolveVaultFile(folder);
          if (!folderAbs) throw new Error("备份目录不合法");
          const skipped: string[] = [];
          let backedUp = 0;
          for (const raw of Array.isArray(info.paths) ? info.paths : []) {
            const rel = String(raw || "").replace(/\\/g, "/");
            if (!rel || rel.includes("..")) {
              skipped.push(rel);
              continue;
            }
            const src = resolveVaultFile(rel);
            if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
              skipped.push(rel);
              continue;
            }
            const dest = path.join(folderAbs, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            backedUp++;
          }
          sendJson(200, { ok: true, backedUp, skipped });
          return;
        }

        // 下载测试：返回确定性伪随机数据，支持任意 offset/len（为正式分块传输铺路）。
        if (pathname === "/api/blob" && req.method === "GET") {
          const mb = clampInt(parseInt(url.searchParams.get("mb") || "1", 10) || 1, 1, MAX_BLOB_MB);
          const blob = getBlob(mb);
          const offset = clampInt(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0, blob.length);
          const lenRaw = parseInt(url.searchParams.get("len") || "", 10);
          const len = Number.isFinite(lenRaw) && lenRaw > 0
            ? Math.min(lenRaw, blob.length - offset)
            : blob.length - offset;
          const slice = blob.subarray(offset, offset + len);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Length", String(slice.length));
          res.setHeader("x-chunk-sha256", sha256(slice));
          res.setHeader("x-total-bytes", String(blob.length));
          res.end(slice);
          return;
        }

        if (pathname === "/api/echo" && req.method === "POST") {
          const body = await readBody(req, MAX_BODY_BYTES);
          sendJson(200, { ok: true, received: body.length, sha256: sha256(body) });
          return;
        }

        if (pathname === "/api/upload/init" && req.method === "POST") {
          const body = await readBody(req, 64 * 1024);
          const info = JSON.parse(body.toString("utf8") || "{}");
          const name = String(info.name || "upload.bin").replace(/[^\w.\-]/g, "_").slice(0, 80);
          const size = Number(info.size) || 0;
          if (size <= 0 || size > MAX_UPLOAD_BYTES) throw new Error("上传大小不合法");
          const id = crypto.randomBytes(8).toString("hex");
          const filePath = path.join(uploadRoot, `${id}-${name}`);
          fs.writeFileSync(filePath, Buffer.alloc(0));
          uploads.set(id, { path: filePath, size, received: 0 });
          sendJson(200, { ok: true, uploadId: id });
          return;
        }

        if (pathname === "/api/upload/chunk" && req.method === "POST") {
          const id = url.searchParams.get("uploadId") || "";
          const state = uploads.get(id);
          if (!state) throw new Error("uploadId 不存在");
          const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
          const body = await readBody(req, MAX_BODY_BYTES);
          const fd = fs.openSync(state.path, "r+");
          try {
            fs.writeSync(fd, body, 0, body.length, offset);
          } finally {
            fs.closeSync(fd);
          }
          state.received += body.length;
          sendJson(200, { ok: true, received: body.length, offset });
          return;
        }

        if (pathname === "/api/upload/finish" && req.method === "POST") {
          const id = url.searchParams.get("uploadId") || "";
          const state = uploads.get(id);
          if (!state) throw new Error("uploadId 不存在");
          const data = fs.readFileSync(state.path);
          uploads.delete(id);
          sendJson(200, {
            ok: true,
            size: data.length,
            declaredSize: state.size,
            received: state.received,
            sha256: sha256(data),
          });
          return;
        }

        sendJson(404, { ok: false, error: `未知接口 ${pathname}` });
      } catch (err: any) {
        sendJson(err && err.statusCode ? err.statusCode : 500, {
          ok: false,
          error: String((err && err.message) || err),
        });
      } finally {
        if (pathname !== "/api/blob") {
          log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
        }
      }
    })();
  });

  const listen = async (): Promise<number> => {
    for (let i = 0; i <= PORT_ATTEMPTS; i++) {
      const port = opts.port + i;
      const ok = await new Promise<boolean>((resolve, reject) => {
        const onError = (err: any) => {
          server.removeListener("listening", onListening);
          if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) resolve(false);
          else reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(true);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "0.0.0.0");
      });
      if (ok) return port;
    }
    throw new Error(`端口 ${opts.port}–${opts.port + PORT_ATTEMPTS} 全部被占用`);
  };

  const port = await listen();

  const addresses: ServerAddress[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info && info.family === "IPv4" && !info.internal) {
        addresses.push({ name, address: info.address, url: `http://${info.address}:${port}` });
      }
    }
  }
  const urls = addresses.map((item) => item.url);
  urls.push(`http://127.0.0.1:${port}`);

  log(`服务已启动，端口 ${port}，地址：${urls.join(" | ")}`);

  return {
    port,
    urls,
    addresses,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
