/**
 * WebDAV 传输的 Obsidian 适配层：把 requestUrl 包装成 WebDavHttp，
 * 其余协议逻辑都在 webdav-protocol.ts（可在 Node 单测）。
 */
import { requestUrl } from "obsidian";
import { WebDavClient, type WebDavConfig, type WebDavHttp, type RemoteCacheEntry } from "./webdav-protocol";
import type { SyncRemote } from "./remote";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

function makeHttp(timeoutMs: number): WebDavHttp {
  return {
    async request({ url, method, headers, body }) {
      // 强制 GET 不走 HTTP 缓存：Obsidian 的 requestUrl 底层是 Electron 网络栈，
      // 会对「同一 URL 的 GET」做启发式缓存（rclone 只给 ETag/Last-Modified、不给
      // Cache-Control）。锁文件 lock.json 的 URL 固定，若不绕过缓存会一直读到旧的
      // 锁内容（表现为「另一台设备正在同步：手机（约 0 分钟后释放）」卡死、且明明
      // 已经拿到锁却被判失败）。文件下载同样是固定 URL 的 GET，也一并绕过，避免
      // 拉到旧内容。用请求头 no-cache 让 Electron 每次回源（已实测有效）。
      const finalHeaders: Record<string, string> = { ...(headers || {}) };
      if (String(method || "GET").toUpperCase() === "GET") {
        finalHeaders["Cache-Control"] = "no-cache";
        finalHeaders["Pragma"] = "no-cache";
      }
      const resp = await withTimeout(
        requestUrl({
          url,
          method,
          headers: finalHeaders,
          body: body as any,
          throw: false,
        }),
        timeoutMs,
        `${method} ${url}`
      );
      return {
        status: resp.status,
        headers: (resp.headers || {}) as Record<string, string>,
        text: typeof resp.text === "string" ? resp.text : "",
        arrayBuffer: resp.arrayBuffer instanceof ArrayBuffer ? resp.arrayBuffer : new ArrayBuffer(0),
      };
    },
  };
}

/** 创建 WebDAV 同步客户端（实现 SyncRemote）。 */
export function createWebDavRemote(
  cfg: WebDavConfig,
  cache?: Map<string, RemoteCacheEntry>
): SyncRemote {
  const client = new WebDavClient(makeHttp(cfg.timeoutMs ?? 30000), cfg, cache);
  return client as unknown as SyncRemote;
}

export { WebDavClient };
export type { WebDavConfig, RemoteCacheEntry };
