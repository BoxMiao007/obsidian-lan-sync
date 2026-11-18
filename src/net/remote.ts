/**
 * 远端（电脑）HTTP 客户端。手机端只做出站请求，走 Obsidian 的 requestUrl。
 *
 * 为什么不用全局 fetch：requestUrl 绕过 CORS 且在所有平台都有；
 * 代价是它没有 abort/timeout，只能在外层用 Promise.race 兜底（请求本身不会真的取消）。
 */
import { requestUrl } from "obsidian";
import { sha256Buffer } from "../core/hash";
import type { Manifest } from "../core/types";

export interface RemoteChunkMeta {
  chunk: ArrayBuffer;
  offset: number;
  fileSize: number;
  fileSha: string | null;
}

export class HttpRemote {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly chunkBytes: number = 4 * 1024 * 1024
  ) {}

  private headers(): Record<string, string> {
    return { "x-lan-sync-token": this.token };
  }

  async fetchManifest(timeoutMs = 60000): Promise<Manifest> {
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/manifest`,
        method: "GET",
        headers: this.headers(),
        throw: false,
      }),
      timeoutMs,
      "获取远端清单"
    );
    if (resp.status !== 200) {
      throw new Error(`获取清单失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
    }
    const body = resp.json as any;
    if (!body || !Array.isArray(body.entries)) throw new Error("远端清单格式不对");
    return { generatedAt: body.generatedAt, entries: body.entries };
  }

  async downloadFile(
    path: string,
    size: number,
    onChunk: (meta: RemoteChunkMeta) => Promise<void> | void,
    timeoutMs = 60000
  ): Promise<{ fileSha: string | null; bytes: number }> {
    let offset = 0;
    let fileSha: string | null = null;
    while (offset < size) {
      const len = Math.min(this.chunkBytes, size - offset);
      const url = `${this.base}/api/v1/file?path=${encodeURIComponent(path)}&offset=${offset}&len=${len}`;
      const resp = await withTimeout(
        requestUrl({ url, method: "GET", headers: this.headers(), throw: false }),
        timeoutMs,
        `下载 ${path}@${offset}`
      );
      if (resp.status !== 200) {
        throw new Error(`下载失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
      }
      const chunk = resp.arrayBuffer;
      if (!chunk || chunk.byteLength !== len) {
        throw new Error(`分块长度不符：${chunk ? chunk.byteLength : 0}/${len}`);
      }
      const expected = resp.headers?.["x-chunk-sha256"];
      if (expected) {
        const actual = await sha256Buffer(chunk);
        if (actual && actual !== expected) throw new Error(`分块哈希不符：${path}@${offset}`);
      }
      fileSha = resp.headers?.["x-file-sha256"] || fileSha;
      await onChunk({ chunk, offset, fileSize: size, fileSha });
      offset += len;
    }
    return { fileSha, bytes: offset };
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
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
