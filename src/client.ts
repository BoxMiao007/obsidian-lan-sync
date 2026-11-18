/**
 * LAN Sync —— 客户端侧网络能力自检（spike）
 *
 * 手机端只有两种出站请求方式：
 * - requestUrl()：Obsidian 原生桥，绕过 CORS，但无超时/无 abort，整包缓冲；
 * - fetch()：标准 WebView 请求，受 CORS 约束，但可以用 AbortController 控制超时。
 * 这两条路都要实测：能不能连上明文 HTTP、大文件会不会崩、分块写盘稳不稳。
 */
import { App, normalizePath, requestUrl } from "obsidian";

export interface Target {
  base: string;
  token: string;
}

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const PING_TIMEOUT = 8000;
const TRANSFER_TIMEOUT = 60000;

export function errMsg(err: any): string {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  return String(err);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms 未响应）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) return "";
  const digest = await subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 仅测试「能不能连上」，不传业务数据。 */
export async function pingWithRequestUrl(target: Target): Promise<StepResult> {
  const started = Date.now();
  try {
    const resp = await withTimeout(
      requestUrl({
        url: `${target.base}/api/ping`,
        method: "GET",
        headers: { "x-lan-sync-token": target.token },
        throw: false,
      }),
      PING_TIMEOUT,
      "requestUrl ping"
    );
    const body: any = resp.json ?? {};
    if (resp.status !== 200 || !body.ok) {
      throw new Error(`HTTP ${resp.status} ${body.error || ""}`.trim());
    }
    return {
      name: "requestUrl 连通性",
      ok: true,
      ms: Date.now() - started,
      detail: `HTTP 200，服务端 ${body.app}@${body.platform}`,
    };
  } catch (err) {
    return { name: "requestUrl 连通性", ok: false, ms: Date.now() - started, detail: errMsg(err) };
  }
}

export async function pingWithFetch(target: Target): Promise<StepResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT);
  try {
    const resp = await fetch(`${target.base}/api/ping`, {
      method: "GET",
      headers: { "x-lan-sync-token": target.token },
      signal: controller.signal,
    });
    const body: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.ok) throw new Error(`HTTP ${resp.status} ${body.error || ""}`.trim());
    return {
      name: "fetch 连通性",
      ok: true,
      ms: Date.now() - started,
      detail: `HTTP 200（CORS 头正常）`,
    };
  } catch (err) {
    return { name: "fetch 连通性", ok: false, ms: Date.now() - started, detail: errMsg(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface DownloadResult extends StepResult {
  chunks: ArrayBuffer[];
  bytes: number;
}

/**
 * 按块下载指定 MB 的测试数据。每块都校验服务端给的 x-chunk-sha256，
 * 这样「分块传输是否正确」不依赖把整包拼起来再算哈希（那正是正式实现要避免的）。
 */
export async function downloadInChunks(
  target: Target,
  mb: number,
  chunkBytes: number
): Promise<DownloadResult> {
  const started = Date.now();
  const total = mb * 1024 * 1024;
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  let hashChecked = 0;
  try {
    for (let offset = 0; offset < total; offset += chunkBytes) {
      const len = Math.min(chunkBytes, total - offset);
      const resp = await withTimeout(
        requestUrl({
          url: `${target.base}/api/blob?mb=${mb}&offset=${offset}&len=${len}`,
          method: "GET",
          headers: { "x-lan-sync-token": target.token },
          throw: false,
        }),
        TRANSFER_TIMEOUT,
        `下载 ${offset}/${total}`
      );
      if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
      const chunk = resp.arrayBuffer;
      if (!chunk || chunk.byteLength !== len) {
        throw new Error(`块长度不符：${chunk ? chunk.byteLength : 0}/${len}`);
      }
      const expected = resp.headers?.["x-chunk-sha256"];
      if (expected) {
        const actual = await sha256Hex(chunk);
        if (actual) {
          if (actual !== expected) throw new Error(`块 ${chunks.length} 哈希不符`);
          hashChecked++;
        }
      }
      chunks.push(chunk);
      received += chunk.byteLength;
    }
    return {
      name: `下载 ${mb}MB（${chunks.length} 块 × ${formatBytes(chunkBytes)}）`,
      ok: true,
      ms: Date.now() - started,
      detail:
        hashChecked === chunks.length
          ? `${formatBytes(received)}，逐块哈希一致`
          : `${formatBytes(received)}，${hashChecked}/${chunks.length} 块校验（无 crypto.subtle，其余未校验）`,
      chunks,
      bytes: received,
    };
  } catch (err) {
    return {
      name: `下载 ${mb}MB（${chunks.length} 块）`,
      ok: false,
      ms: Date.now() - started,
      detail: errMsg(err),
      chunks,
      bytes: received,
    };
  }
}

export interface WriteResult extends StepResult {
  path: string;
}

/** 把分块数据写进库内临时目录，验证移动端 writeBinary / appendBinary 的真实表现。 */
export async function writeChunksToVault(
  app: App,
  relPath: string,
  chunks: ArrayBuffer[]
): Promise<WriteResult> {
  const started = Date.now();
  const adapter: any = app.vault.adapter;
  const path = normalizePath(relPath);
  const dir = path.split("/").slice(0, -1).join("/");
  let method = "writeBinary";
  try {
    await ensureDir(adapter, dir);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await adapter.writeBinary(path, chunks[i]);
      } else if (typeof adapter.appendBinary === "function") {
        method = "writeBinary + appendBinary";
        await adapter.appendBinary(path, chunks[i]);
      } else {
        method = "writeBinary + 读回拼接（appendBinary 不可用）";
        const prev = await adapter.readBinary(path);
        await adapter.writeBinary(path, concatBuffers(prev, chunks[i]));
      }
    }
    const stat = await adapter.stat(path);
    const size = stat?.size ?? -1;
    const expected = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    if (size !== expected) throw new Error(`落盘大小不符：${size}/${expected}`);
    return {
      name: `写盘 ${formatBytes(expected)}（${method}）`,
      ok: true,
      ms: Date.now() - started,
      detail: path,
      path,
    };
  } catch (err) {
    return { name: `写盘（${method}）`, ok: false, ms: Date.now() - started, detail: errMsg(err), path };
  }
}

/** 手机 → 电脑方向的上传测试（正式同步里手机推送改动走同一条路）。 */
export async function uploadInChunks(
  target: Target,
  sizeBytes: number,
  chunkBytes: number
): Promise<StepResult> {
  const started = Date.now();
  const name = `上传 ${formatBytes(sizeBytes)}（${Math.ceil(sizeBytes / chunkBytes)} 块）`;
  try {
    const payload = makeTestBuffer(sizeBytes);
    const localSha = await sha256Hex(payload);
    const init = await withTimeout(
      requestUrl({
        url: `${target.base}/api/upload/init`,
        method: "POST",
        headers: { "x-lan-sync-token": target.token, "content-type": "application/json" },
        body: JSON.stringify({ name: `selftest-${sizeBytes}.bin`, size: sizeBytes }),
        throw: false,
      }),
      PING_TIMEOUT,
      "upload init"
    );
    if (init.status !== 200) throw new Error(`init HTTP ${init.status}`);
    const uploadId = init.json?.uploadId;
    if (!uploadId) throw new Error("没有拿到 uploadId");

    let offset = 0;
    while (offset < sizeBytes) {
      const len = Math.min(chunkBytes, sizeBytes - offset);
      const part = payload.slice(offset, offset + len);
      const resp = await withTimeout(
        requestUrl({
          url: `${target.base}/api/upload/chunk?uploadId=${uploadId}&offset=${offset}`,
          method: "POST",
          headers: { "x-lan-sync-token": target.token, "content-type": "application/octet-stream" },
          body: part,
          throw: false,
        }),
        TRANSFER_TIMEOUT,
        `upload chunk ${offset}`
      );
      if (resp.status !== 200) throw new Error(`chunk HTTP ${resp.status}`);
      offset += len;
    }

    const fin = await withTimeout(
      requestUrl({
        url: `${target.base}/api/upload/finish?uploadId=${uploadId}`,
        method: "POST",
        headers: { "x-lan-sync-token": target.token },
        throw: false,
      }),
      TRANSFER_TIMEOUT,
      "upload finish"
    );
    const result = fin.json ?? {};
    if (result.size !== sizeBytes) throw new Error(`大小不符：${result.size}/${sizeBytes}`);
    if (localSha && result.sha256 !== localSha) throw new Error("服务端哈希与本地不一致");
    return {
      name,
      ok: true,
      ms: Date.now() - started,
      detail: `${formatBytes(result.size)}，哈希一致`,
    };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, detail: errMsg(err) };
  }
}

async function ensureDir(adapter: any, dir: string): Promise<void> {
  if (!dir) return;
  const parts = dir.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

function concatBuffers(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}

function makeTestBuffer(sizeBytes: number): ArrayBuffer {
  const buf = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buf[i] = (i * 17 + 3) & 0xff;
  return buf.buffer;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
