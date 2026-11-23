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
      const resp = await withTimeout(
        requestUrl({
          url,
          method,
          headers,
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
