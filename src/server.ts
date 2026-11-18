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

export interface SyncServerOptions {
  /** 期望端口，被占用时自动往后顺延 */
  port: number;
  /** 配对码 / 请求令牌 */
  token: string;
  /** 上传落盘目录（必须位于库内，手机端看不到库外路径） */
  uploadDir: string;
  /** 本插件在电脑上的绝对目录，用于给手机端提供安装文件下载 */
  pluginDir?: string;
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
  const blobCache = new Map<string, any>();

  const uploadRoot = path.join(opts.uploadDir, "spike-uploads");
  fs.mkdirSync(uploadRoot, { recursive: true });

  const sha256 = (buf: any): string => crypto.createHash("sha256").update(buf).digest("hex");

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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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
          const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LAN Sync 安装</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;line-height:1.6;max-width:720px}
code{background:#eee;padding:2px 4px;border-radius:3px}a{color:#2563eb}
#result{font-weight:600}</style></head>
<body>
<h1>LAN Sync · 手机安装助手</h1>
<p>能看到这一页，说明手机浏览器已经能访问这台电脑（${port}）。</p>
<p><button id="test">测试 /api/ping</button> <span id="result">未测试</span></p>
<h2>下载插件文件</h2>
<p>当前页面链接里的配对码：<code>${token ? "已带上" : "缺失，请从电脑设置页复制完整链接"}</code></p>
<ul>${fileLinks}</ul>
<h2>安装步骤</h2>
<ol>
<li>把上面三个文件下载到手机。</li>
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

        if (pathname === "/install/file" && req.method === "GET") {
          if (!authorized()) {
            sendJson(401, { ok: false, error: "配对码不正确" });
            return;
          }
          const name = url.searchParams.get("name") || "";
          if (!["main.js", "manifest.json", "styles.css"].includes(name) || !opts.pluginDir) {
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
        sendJson(500, { ok: false, error: String((err && err.message) || err) });
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
