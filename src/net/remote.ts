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
  private sessionId: string | null = null;

  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly chunkBytes: number = 4 * 1024 * 1024
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "x-lan-sync-token": this.token };
    if (this.sessionId) headers["x-lan-sync-session"] = this.sessionId;
    return headers;
  }

  /** 服务端同一时刻只允许一个同步会话，避免两台设备交叉写 */
  async startSession(): Promise<void> {
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/session/start`,
        method: "POST",
        headers: this.headers(),
        throw: false,
      }),
      15000,
      "建立同步会话"
    );
    if (resp.status !== 200 || !resp.json?.sessionId) {
      throw new Error(resp.json?.error || `无法开始同步（HTTP ${resp.status}）`);
    }
    this.sessionId = resp.json.sessionId;
  }

  async endSession(): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    try {
      await withTimeout(
        requestUrl({
          url: `${this.base}/api/v1/session/end?sessionId=${id}`,
          method: "POST",
          headers: { "x-lan-sync-token": this.token, "x-lan-sync-session": id },
          throw: false,
        }),
        5000,
        "结束同步会话"
      );
    } catch {
      /* 服务端有 10 分钟超时兜底 */
    }
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

  async initUpload(path: string, size: number, sha256: string | null): Promise<string> {
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/upload/init`,
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ path, size, sha256 }),
        throw: false,
      }),
      30000,
      `上传初始化 ${path}`
    );
    if (resp.status !== 200 || !resp.json?.uploadId) {
      throw new Error(`上传初始化失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
    }
    return resp.json.uploadId;
  }

  async uploadChunk(uploadId: string, offset: number, chunk: ArrayBuffer): Promise<void> {
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/upload/chunk?uploadId=${uploadId}&offset=${offset}`,
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/octet-stream" },
        body: chunk,
        throw: false,
      }),
      120000,
      `上传分块 ${offset}`
    );
    if (resp.status !== 200) {
      throw new Error(`上传分块失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
    }
  }

  async finishUpload(uploadId: string): Promise<{ size: number; sha256: string | null }> {
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/upload/finish?uploadId=${uploadId}`,
        method: "POST",
        headers: this.headers(),
        throw: false,
      }),
      120000,
      "上传收尾"
    );
    if (resp.status !== 200) {
      throw new Error(`上传收尾失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
    }
    return { size: resp.json?.entry?.size ?? -1, sha256: resp.json?.entry?.sha256 ?? null };
  }

  async deleteRemote(path: string): Promise<void> {
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/file?path=${encodeURIComponent(path)}`,
        method: "DELETE",
        headers: this.headers(),
        throw: false,
      }),
      30000,
      `删除远端 ${path}`
    );
    if (resp.status !== 200) {
      throw new Error(`删除远端失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
    }
  }

  /** 让电脑端在覆盖/删除之前把文件备份到 .trash，返回实际备份数量。 */
  async backupFiles(paths: string[], folder: string): Promise<number> {
    if (paths.length === 0) return 0;
    const resp = await withTimeout(
      requestUrl({
        url: `${this.base}/api/v1/backup`,
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ paths, folder }),
        throw: false,
      }),
      60000,
      "备份电脑端文件"
    );
    if (resp.status !== 200) {
      throw new Error(`备份电脑端失败：HTTP ${resp.status} ${resp.json?.error || ""}`.trim());
    }
    return Number(resp.json?.backedUp) || 0;
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
