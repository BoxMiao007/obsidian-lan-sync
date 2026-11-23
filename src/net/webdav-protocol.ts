/**
 * WebDAV 同步客户端（纯逻辑，不依赖 Obsidian）。
 *
 * 为什么单独抽出来：WebDAV 是「哑存储」，没有清单/哈希/会话/备份接口。
 * 这里用 PROPFIND 列目录、GET(Range) 下载、PUT 临时文件 + MOVE 原子替换、
 * COPY 备份、以及一个「锁文件 + 租约」做跨设备互斥。
 *
 * 通过注入的 `http` 发请求：正式环境用 Obsidian 的 requestUrl（见 webdav.ts），
 * 测试里用内存假服务器，所以本文件可以在 Node 里直接单测。
 */
import { sha256Buffer } from "../core/hash";
import { detectConflictMarkers } from "../core/conflict-markers";
import { isIgnored, type IgnoreConfig } from "../core/ignore";
import type { FileEntry, Manifest } from "../core/types";

export interface WebDavResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export interface WebDavRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface WebDavHttp {
  request(req: WebDavRequest): Promise<WebDavResponse>;
}

export interface WebDavConfig {
  /** 例：http://127.0.0.1:8080 */
  baseUrl: string;
  /** 同步根（相对 WebDAV 根），例：<路径前缀>/<库名>，前缀可留空 */
  root: string;
  user: string;
  pass: string;
  /** 设备标识（锁文件里区分谁在同步） */
  deviceId: string;
  /** 设备名（写进冲突副本名/锁），例：电脑 / 手机 */
  deviceName: string;
  /** 忽略规则（与本地一致） */
  ignore: IgnoreConfig;
  chunkBytes?: number;
  maxHashBytes?: number;
  timeoutMs?: number;
  retryBaseMs?: number;
  maxRetries?: number;
  /** 可选日志回调（失败回退、抢锁等诊断信息） */
  onLog?: (msg: string) => void;
}

/** 远端哈希缓存条目：ETag（modtime+size 令牌）+ 上次算出的内容哈希 */
export interface RemoteCacheEntry {
  etag: string;
  size: number;
  mtime: number;
  sha256: string | null;
  unsafe: boolean;
}

export interface RawRemoteEntry {
  path: string;
  size: number;
  mtime: number;
  etag: string;
  isDir: boolean;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/>" +
  "</d:prop></d:propfind>";

const LOCK_PATH = ".lansync/lock.json";

export class WebDavClient {
  readonly cache: Map<string, RemoteCacheEntry>;
  private startedAt = 0;
  private lockHeld = false;
  private heartbeat: any = null;

  constructor(private readonly http: WebDavHttp, private readonly cfg: WebDavConfig, cache?: Map<string, RemoteCacheEntry>) {
    this.cache = cache ?? new Map();
  }

  // ---------- 基础请求 ----------

  private authHeader(): string {
    const raw = `${this.cfg.user}:${this.cfg.pass}`;
    return `Basic ${base64Encode(raw)}`;
  }

  private encodePath(p: string): string {
    return p
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => encodeURIComponent(s))
      .join("/");
  }

  private decodePath(p: string): string {
    return p
      .split("/")
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join("/");
  }

  /** 生成某相对路径（相对同步根）的绝对 URL。isDir 时补末尾 /。 */
  urlFor(relPath: string, isDir = false): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const root = this.cfg.root.replace(/^\/+|\/+$/g, "");
    const full = [root, relPath.replace(/^\/+/, "")].filter(Boolean).join("/");
    let url = `${base}/${this.encodePath(full)}`;
    if (isDir && !url.endsWith("/")) url += "/";
    return url;
  }

  /** 把 PROPFIND 返回的 href 映射回相对同步根的路径。 */
  private hrefToRel(href: string): string {
    let p = href;
    if (/^https?:/i.test(p)) {
      try {
        p = new URL(p).pathname;
      } catch {
        /* 保持原样 */
      }
    }
    p = this.decodePath(p.replace(/^\/+/, "")).replace(/\/+$/, "");
    const root = this.cfg.root.replace(/^\/+|\/+$/g, "");
    if (root && p === root) return "";
    if (root && p.startsWith(`${root}/`)) return p.slice(root.length + 1);
    return p;
  }

  private async request(method: string, url: string, opts: {
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  } = {}): Promise<WebDavResponse> {
    const headers: Record<string, string> = { Authorization: this.authHeader(), ...(opts.headers || {}) };
    const maxRetries = this.cfg.maxRetries ?? 2;
    const baseDelay = this.cfg.retryBaseMs ?? 300;
    let attempt = 0;
    // 指数退避：429/5xx 与网络异常重试
    for (;;) {
      try {
        const resp = await this.http.request({ url, method, headers, body: opts.body });
        if (resp.status === 429 || resp.status === 500 || resp.status === 502 || resp.status === 503 || resp.status === 504) {
          if (attempt < maxRetries) {
            await delay(baseDelay * Math.pow(2, attempt));
            attempt++;
            continue;
          }
        }
        return resp;
      } catch (err) {
        if (attempt < maxRetries) {
          await delay(baseDelay * Math.pow(2, attempt));
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  // ---------- 连通与目录 ----------

  /** 轻量连通性/认证探测。可达即返回；401/403 抛认证错误。 */
  async probe(): Promise<void> {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const resp = await this.request("PROPFIND", `${base}/`, {
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (resp.status === 401 || resp.status === 403) throw new Error(`WebDAV 认证失败（HTTP ${resp.status}）`);
    // 真正的 WebDAV 对 PROPFIND 返回 207 Multi-Status；200 多为普通 HTTP 站点，不能当作 WebDAV。
    if (resp.status !== 207) throw new Error(`WebDAV 不可用（HTTP ${resp.status}）`);
  }

  private async mkcol(relDir: string): Promise<void> {
    const parts = relDir.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const resp = await this.request("MKCOL", this.urlFor(cur, true));
      // 201 创建成功；405/301/302 表示已存在或重定向（视为可用）
      if (![201, 200, 204, 405, 301, 302].includes(resp.status)) {
        if (resp.status === 409) continue; // 父目录问题，下一轮会补
        throw new Error(`创建目录失败 ${cur}（HTTP ${resp.status}）`);
      }
    }
  }

  /** 从 WebDAV 根逐段创建同步根目录（root 是绝对同步根，不再拼一次 root）。 */
  private async ensureRoot(): Promise<void> {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const segments = this.cfg.root.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    let cur = "";
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      const resp = await this.request("MKCOL", `${base}/${this.encodePath(cur)}`);
      if (![201, 200, 204, 405, 301, 302, 409].includes(resp.status)) {
        throw new Error(`创建同步根失败 ${cur}（HTTP ${resp.status}）`);
      }
    }
  }

  private async list(relDir: string): Promise<RawRemoteEntry[]> {
    const resp = await this.request("PROPFIND", this.urlFor(relDir, true), {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (resp.status === 404) return [];
    if (resp.status !== 207 && resp.status !== 200) {
      throw new Error(`列目录失败 ${relDir || "/"}（HTTP ${resp.status}）`);
    }
    const parsed = parseMultiStatus(resp.text);
    const out: RawRemoteEntry[] = [];
    for (const item of parsed) {
      const rel = this.hrefToRel(item.href);
      if (rel === relDir || rel === "") continue; // 跳过目录自身
      const mtime = parseHttpDate(item.lastmodified);
      out.push({ path: rel, size: item.size, mtime, etag: item.etag, isDir: item.isDir });
    }
    return out;
  }

  /** 递归列目录（BFS），套用忽略规则，跳过 .lansync 元数据目录。 */
  async recursiveList(): Promise<RawRemoteEntry[]> {
    const result: RawRemoteEntry[] = [];
    const queue: string[] = [""];
    const seen = new Set<string>();
    while (queue.length) {
      const dir = queue.shift() as string;
      if (seen.has(dir)) continue;
      seen.add(dir);
      let items: RawRemoteEntry[];
      // 列目录失败（网络/5xx）必须上抛：否则该子树文件会被当成「远端已删」而误删本机。
      // 目录不存在（404）在 list() 里已按空目录处理。
      items = await this.list(dir);
      for (const item of items) {
        if (item.path === ".lansync" || item.path.startsWith(".lansync/")) continue;
        if (isIgnored(item.path, this.cfg.ignore)) continue;
        if (item.isDir) {
          queue.push(item.path);
        } else {
          result.push(item);
        }
      }
    }
    return result;
  }

  // ---------- 远端清单（带哈希缓存） ----------

  /**
   * 生成远端清单。ETag 未变且 size 未变 → 复用缓存里的 sha256；
   * 否则（≤ maxHashBytes）下载整文件重算。避免每次全量下载。
   */
  async fetchManifest(timeoutMs?: number): Promise<Manifest> {
    const raw = await this.recursiveList();
    const maxHashBytes = this.cfg.maxHashBytes ?? 24 * 1024 * 1024;
    const token = (e: RawRemoteEntry) => e.etag || `${e.size}:${e.mtime}`;
    const entries: FileEntry[] = [];
    const alive = new Set<string>();

    for (const item of raw) {
      alive.add(item.path);
      const key = token(item);
      const cached = this.cache.get(item.path);
      let sha256: string | null = null;
      let unsafe = false;
      if (cached && cached.etag === key && cached.size === item.size) {
        sha256 = cached.sha256;
        unsafe = cached.unsafe;
      } else if (item.size <= maxHashBytes) {
        try {
          const buf = await this.downloadWhole(item.path, item.size, timeoutMs);
          sha256 = await sha256Buffer(buf);
          unsafe = detectConflictMarkers(buf);
        } catch {
          sha256 = null;
          unsafe = false;
        }
      }
      this.cache.set(item.path, { etag: key, size: item.size, mtime: item.mtime, sha256, unsafe });
      entries.push({ path: item.path, size: item.size, mtime: item.mtime, sha256, unsafe });
    }

    // 清理已不存在的缓存条目
    for (const path of Array.from(this.cache.keys())) {
      if (!alive.has(path)) this.cache.delete(path);
    }

    return { generatedAt: Date.now(), entries };
  }

  // ---------- 下载 ----------

  private async downloadWhole(path: string, size: number, timeoutMs?: number): Promise<ArrayBuffer> {
    if (size === 0) return new ArrayBuffer(0);
    const resp = await this.request("GET", this.urlFor(path), { headers: {} });
    if (resp.status !== 200 && resp.status !== 206) throw new Error(`下载失败 ${path}（HTTP ${resp.status}）`);
    if (resp.arrayBuffer.byteLength !== size) {
      throw new Error(`下载大小不符 ${path}：${resp.arrayBuffer.byteLength}/${size}`);
    }
    return resp.arrayBuffer;
  }

  async downloadFile(
    path: string,
    size: number,
    onChunk: (meta: { chunk: ArrayBuffer; offset: number; fileSize: number; fileSha: string | null }) => Promise<void> | void,
    _timeoutMs?: number
  ): Promise<{ fileSha: string | null; bytes: number }> {
    const chunkBytes = this.cfg.chunkBytes ?? 4 * 1024 * 1024;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(chunkBytes, size - offset);
      const resp = await this.request("GET", this.urlFor(path), {
        headers: { Range: `bytes=${offset}-${offset + len - 1}` },
      });
      let chunk: ArrayBuffer;
      if (resp.status === 206) {
        chunk = resp.arrayBuffer;
      } else if (resp.status === 200) {
        // 服务器忽略 Range：仅当要的是整文件时才可接受
        if (offset !== 0 || len !== size) throw new Error(`服务器不支持 Range（${path}）`);
        chunk = resp.arrayBuffer;
      } else {
        throw new Error(`下载失败 ${path}@${offset}（HTTP ${resp.status}）`);
      }
      if (chunk.byteLength !== len) throw new Error(`分块长度不符 ${path}@${offset}：${chunk.byteLength}/${len}`);
      await onChunk({ chunk, offset, fileSize: size, fileSha: null });
      offset += len;
    }
    return { fileSha: null, bytes: offset };
  }

  // ---------- 上传（临时文件 + MOVE 原子替换） ----------

  async putFile(
    path: string,
    data: ArrayBuffer,
    sha256: string | null,
    mtime: number
  ): Promise<{ size: number; sha256: string | null }> {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "";
    if (dir) await this.mkcol(dir);

    const tmpPath = `${path}.lansync-tmp-${Math.random().toString(36).slice(2, 10)}`;
    const mtimeSec = mtime > 0 ? Math.floor(mtime / 1000) : 0;
    const putHeaders: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (mtimeSec > 0) putHeaders["X-OC-Mtime"] = String(mtimeSec);
    const putResp = await this.request("PUT", this.urlFor(tmpPath), { headers: putHeaders, body: data });
    if (putResp.status !== 201 && putResp.status !== 200 && putResp.status !== 204) {
      throw new Error(`上传临时文件失败 ${path}（HTTP ${putResp.status}）`);
    }

    const moveHeaders: Record<string, string> = {
      Destination: this.urlFor(path),
      Overwrite: "T",
    };
    if (mtimeSec > 0) moveHeaders["X-OC-Mtime"] = String(mtimeSec);
    const moveResp = await this.request("MOVE", this.urlFor(tmpPath), { headers: moveHeaders });
    if (moveResp.status >= 300) {
      // 某些服务器 MOVE 不支持/失败：退回直接 PUT 覆盖（非原子，存在写入中途被读到半截文件的风险）
      this.cfg.onLog?.(`MOVE 原子替换失败（HTTP ${moveResp.status}），退回非原子直接 PUT：${path}`);
      const direct: Record<string, string> = { "Content-Type": "application/octet-stream" };
      if (mtimeSec > 0) direct["X-OC-Mtime"] = String(mtimeSec);
      const retry = await this.request("PUT", this.urlFor(path), { headers: direct, body: data });
      if (retry.status !== 201 && retry.status !== 200 && retry.status !== 204) {
        throw new Error(`上传失败 ${path}（HTTP ${retry.status}）`);
      }
      try {
        await this.request("DELETE", this.urlFor(tmpPath));
      } catch {
        /* 忽略 */
      }
    }

    // 缓存失效：内容已变，下一轮 PROPFIND 会重新取 ETag
    this.cache.delete(path);
    const finalSha = sha256 ?? (await sha256Buffer(data));
    return { size: data.byteLength, sha256: finalSha };
  }

  // ---------- 删除 / 备份 ----------

  async deleteRemote(path: string): Promise<void> {
    const resp = await this.request("DELETE", this.urlFor(path));
    if (![200, 204, 404].includes(resp.status)) throw new Error(`删除失败 ${path}（HTTP ${resp.status}）`);
    this.cache.delete(path);
  }

  async backupFiles(paths: string[], folder: string): Promise<number> {
    let count = 0;
    const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
    for (const path of paths) {
      const dest = `${cleanFolder}/${path}`;
      const slash = dest.lastIndexOf("/");
      if (slash > 0) await this.mkcol(dest.slice(0, slash));
      const resp = await this.request("COPY", this.urlFor(path), {
        headers: { Destination: this.urlFor(dest), Overwrite: "T" },
      });
      if ([201, 200, 204, 207].includes(resp.status)) {
        count++;
      } else if (resp.status === 404) {
        // 源已不存在，无需备份
      } else {
        // 备份失败必须上抛：宁可中止同步，也不能在没备份的情况下覆盖/删除远端
        throw new Error(`备份失败 ${path}（HTTP ${resp.status}）`);
      }
    }
    return count;
  }

  // ---------- 锁文件（跨设备互斥 + 租约） ----------

  private async readLock(): Promise<{ deviceId: string; device: string; startedAt: number; expiresAt: number } | null> {
    const resp = await this.request("GET", this.urlFor(LOCK_PATH));
    if (resp.status === 404 || resp.status === 200 && !resp.text) return null;
    if (resp.status !== 200) return null;
    try {
      return JSON.parse(resp.text);
    } catch {
      return null;
    }
  }

  /**
   * 尝试获取锁；返回是否成功，以及当前持有者。
   *
   * 用 `MOVE Overwrite:F` 原子抢锁：目标已存在则服务器回 412，绝不覆盖。这样即便
   * readLock 之后、MOVE 之前被别的设备抢到锁，也不会把它悄悄覆盖掉（旧实现回退成
   * Overwrite:T，会清掉对方的锁，导致两设备同时写）。过期锁则允许用 Overwrite:T 接管。
   */
  async acquireLock(ttlMs: number): Promise<{ acquired: boolean; holder?: { device: string; expiresAt: number } }> {
    const now = Date.now();
    // 快路径：已有未过期的他人锁，直接判定失败（不去打扰对方）
    const existing = await this.readLock();
    if (existing && existing.deviceId !== this.cfg.deviceId && existing.expiresAt > now) {
      return { acquired: false, holder: { device: existing.device, expiresAt: existing.expiresAt } };
    }

    const payload = JSON.stringify({
      deviceId: this.cfg.deviceId,
      device: this.cfg.deviceName,
      startedAt: now,
      expiresAt: now + ttlMs,
    });

    const dir = LOCK_PATH.slice(0, LOCK_PATH.lastIndexOf("/"));
    await this.mkcol(dir);
    const tmpPath = `${LOCK_PATH}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    const put = await this.request("PUT", this.urlFor(tmpPath), {
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    if (put.status < 200 || put.status >= 300) {
      return { acquired: false, holder: existing ? { device: existing.device, expiresAt: existing.expiresAt } : undefined };
    }

    // 原子抢锁：Overwrite:F（目标已存在则 412，不覆盖）
    let move = await this.request("MOVE", this.urlFor(tmpPath), {
      headers: { Destination: this.urlFor(LOCK_PATH), Overwrite: "F" },
    });
    if (move.status === 412 || move.status === 409) {
      const cur = await this.readLock();
      const foreignLive = cur && cur.deviceId !== this.cfg.deviceId && cur.expiresAt > Date.now();
      if (foreignLive) {
        // 有别的设备正持锁：放弃，绝不覆盖
        await this.request("DELETE", this.urlFor(tmpPath));
        return { acquired: false, holder: { device: cur!.device, expiresAt: cur!.expiresAt } };
      }
      // 过期锁或自己遗留的锁：允许接管
      move = await this.request("MOVE", this.urlFor(tmpPath), {
        headers: { Destination: this.urlFor(LOCK_PATH), Overwrite: "T" },
      });
    }
    if (move.status < 200 || move.status >= 300) {
      await this.request("DELETE", this.urlFor(tmpPath));
      const cur = await this.readLock();
      return { acquired: false, holder: cur ? { device: cur.device, expiresAt: cur.expiresAt } : undefined };
    }
    // 写后回读校验，进一步降低并发抢锁风险
    const cur = await this.readLock();
    if (!cur || cur.deviceId !== this.cfg.deviceId) {
      return { acquired: false, holder: cur ? { device: cur.device, expiresAt: cur.expiresAt } : undefined };
    }
    this.lockHeld = true;
    this.startedAt = now;
    return { acquired: true };
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    const cur = await this.readLock();
    if (cur && cur.deviceId === this.cfg.deviceId) {
      try {
        await this.request("DELETE", this.urlFor(LOCK_PATH));
      } catch {
        /* 租约到期会自动失效 */
      }
    }
  }

  // ---------- 会话（锁）生命周期 ----------

  async startSession(ttlMs = 15 * 60 * 1000): Promise<void> {
    await this.ensureRoot();
    const res = await this.acquireLock(ttlMs);
    if (!res.acquired) {
      const who = res.holder ? `${res.holder.device}（约 ${Math.max(0, Math.round((res.holder.expiresAt - Date.now()) / 60000))} 分钟后释放）` : "另一台设备";
      throw new Error(`另一台设备正在同步：${who}，请稍后再试`);
    }
    // 心跳续租，避免长同步期间锁过期
    if (typeof setInterval === "function") {
      const renewMs = Math.max(30000, Math.floor(ttlMs / 2));
      this.heartbeat = setInterval(() => {
        void this.renewLock(ttlMs);
      }, renewMs);
      if (this.heartbeat && typeof this.heartbeat.unref === "function") this.heartbeat.unref();
    }
  }

  private async renewLock(ttlMs: number): Promise<void> {
    if (!this.lockHeld) return;
    const cur = await this.readLock();
    if (!cur || cur.deviceId !== this.cfg.deviceId) return; // 锁已丢失，不再抢
    try {
      await this.acquireLock(ttlMs);
    } catch {
      /* 续租失败不致命，租约到期后其他设备可接管 */
    }
  }

  async endSession(): Promise<void> {
    if (this.heartbeat && typeof clearInterval === "function") {
      clearInterval(this.heartbeat);
    }
    this.heartbeat = null;
    await this.releaseLock();
  }
}

// ---------- 辅助函数 ----------

interface MultiStatusItem {
  href: string;
  isDir: boolean;
  size: number;
  lastmodified: string;
  etag: string;
}

function pickTag(block: string, name: string): string {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i");
  const m = re.exec(block);
  return m ? decodeXmlEntities(m[1].trim()) : "";
}

function parseMultiStatus(xml: string): MultiStatusItem[] {
  const out: MultiStatusItem[] = [];
  const respRe = /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let m: RegExpExecArray | null;
  while ((m = respRe.exec(xml))) {
    const block = m[1];
    const href = pickTag(block, "href");
    if (!href) continue;
    const isDir = /<(?:\w+:)?resourcetype\b[^>]*>[\s\S]*?<(?:\w+:)?collection\b/i.test(block);
    const sizeStr = pickTag(block, "getcontentlength");
    out.push({
      href,
      isDir,
      size: sizeStr ? parseInt(sizeStr, 10) || 0 : 0,
      lastmodified: pickTag(block, "getlastmodified"),
      etag: pickTag(block, "getetag").replace(/^"|"$/g, ""),
    });
  }
  return out;
}

function parseHttpDate(value: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  if (typeof btoa === "function") return btoa(bin);
  // 兜底（Node 有 Buffer）
  const anyGlobal: any = globalThis as any;
  if (anyGlobal.Buffer) return anyGlobal.Buffer.from(bytes).toString("base64");
  throw new Error("当前环境缺少 base64 能力");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
