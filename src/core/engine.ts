/**
 * 执行层：把「同步计划」变成真实的文件读写。
 * 只依赖适配器接口，方便用 Node 假适配器做端到端测试。
 */
import type { ManifestAdapter } from "./manifest";
import type { Baseline, FileEntry } from "./types";
import { updateBaseline, type ChangeItem, type SyncPlan } from "./plan";
import { sha256Buffer } from "./hash";

export interface EngineAdapter extends ManifestAdapter {
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary?(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface FileDownloader {
  downloadFile(
    path: string,
    size: number,
    onChunk: (meta: { chunk: ArrayBuffer; offset: number }) => Promise<void> | void
  ): Promise<{ fileSha: string | null; bytes: number }>;
}

export interface RemoteWriter {
  initUpload(path: string, size: number, sha256: string | null): Promise<string>;
  uploadChunk(uploadId: string, offset: number, chunk: ArrayBuffer): Promise<void>;
  finishUpload(uploadId: string): Promise<{ size: number; sha256: string | null }>;
  deleteRemote(path: string): Promise<void>;
}

export interface ApplyOptions {
  /** 传输中间文件目录（必须在库内，例如 .obsidian/plugins/lan-sync/tmp） */
  tmpDir: string;
  /** 远端清单，用于把「未变」文件也补进基线 */
  remoteEntries: FileEntry[];
  onProgress?: (info: { done: number; total: number; label: string; bytes: number }) => void;
}

export interface ApplyResult {
  appliedDownloads: ChangeItem[];
  appliedDeletes: string[];
  errors: Array<{ path: string; message: string }>;
  bytes: number;
  newBaseline: Baseline;
}

export async function applyPullPlan(
  adapter: EngineAdapter,
  downloader: FileDownloader,
  plan: SyncPlan,
  baseline: Baseline,
  options: ApplyOptions
): Promise<ApplyResult> {
  const errors: Array<{ path: string; message: string }> = [];
  const appliedDownloads: ChangeItem[] = [];
  const appliedDeletes: string[] = [];

  // 防御性检查：即使调用方忘了拦，熔断的计划也绝不动文件
  if (plan.breaker) {
    return {
      appliedDownloads,
      appliedDeletes,
      errors: [{ path: "*", message: plan.breaker.message }],
      bytes: 0,
      newBaseline: baseline,
    };
  }
  const total = plan.downloads.length + plan.deleteLocal.length;
  let done = 0;
  let bytes = 0;

  for (let i = 0; i < plan.downloads.length; i++) {
    const item = plan.downloads[i];
    const tmpPath = `${options.tmpDir}/dl-${Date.now()}-${i}.part`;
    try {
      await ensureDir(adapter, dirname(tmpPath));
      let first = true;
      let received = 0;
      const result = await downloader.downloadFile(item.path, item.size, async ({ chunk, offset }) => {
        if (first) {
          await adapter.writeBinary(tmpPath, chunk);
          first = false;
        } else if (typeof adapter.appendBinary === "function") {
          await adapter.appendBinary(tmpPath, chunk);
        } else {
          throw new Error("当前适配器不支持 appendBinary，无法分块写入");
        }
        received += chunk.byteLength;
        options.onProgress?.({ done, total, label: `${item.path}@${offset}`, bytes });
      });

      if (received !== item.size) throw new Error(`大小不符：${received}/${item.size}`);
      const stat = await adapter.stat(tmpPath);
      if (!stat || stat.size !== item.size) throw new Error(`临时文件大小异常：${stat?.size}`);

      await ensureDir(adapter, dirname(item.path));
      if (await adapter.exists(item.path)) await adapter.remove(item.path);
      await adapter.rename(tmpPath, item.path);

      bytes += received;
      appliedDownloads.push({ ...item, sha256: item.sha256 ?? result.fileSha ?? null });
    } catch (err: any) {
      errors.push({ path: item.path, message: String((err && err.message) || err) });
      try {
        if (await adapter.exists(tmpPath)) await adapter.remove(tmpPath);
      } catch {
        /* 清理失败不影响主流程 */
      }
    } finally {
      done++;
      options.onProgress?.({ done, total, label: item.path, bytes });
    }
  }

  for (const path of plan.deleteLocal) {
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
      appliedDeletes.push(path);
    } catch (err: any) {
      errors.push({ path, message: String((err && err.message) || err) });
    } finally {
      done++;
      options.onProgress?.({ done, total, label: `删除 ${path}`, bytes });
    }
  }

  const unchangedRemote = options.remoteEntries.filter((entry) =>
    plan.unchangedPaths.includes(entry.path)
  );

  return {
    appliedDownloads,
    appliedDeletes,
    errors,
    bytes,
    newBaseline: updateBaseline(baseline, appliedDownloads, appliedDeletes, unchangedRemote),
  };
}

export interface PushApplyOptions {
  chunkBytes?: number;
  remoteEntries: FileEntry[];
  /** 单文件上传上限，默认 32MB：手机端 readBinary 是整包读，超过会 OOM */
  maxUploadBytes?: number;
  onProgress?: (info: { done: number; total: number; label: string; bytes: number }) => void;
}

/** 把本机的新增/修改推送到远端，并删除远端已被本机删除的文件。 */
export async function applyPushPlan(
  adapter: EngineAdapter,
  remote: RemoteWriter,
  plan: SyncPlan,
  baseline: Baseline,
  options: PushApplyOptions
): Promise<ApplyResult> {
  const errors: Array<{ path: string; message: string }> = [];
  const appliedUploads: ChangeItem[] = [];
  const appliedDeletes: string[] = [];

  if (plan.breaker) {
    return {
      appliedDownloads: appliedUploads,
      appliedDeletes,
      errors: [{ path: "*", message: plan.breaker.message }],
      bytes: 0,
      newBaseline: baseline,
    };
  }

  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
  const maxUploadBytes = options.maxUploadBytes ?? 32 * 1024 * 1024;
  const total = plan.uploads.length + plan.deleteRemote.length;
  let done = 0;
  let bytes = 0;

  for (let i = 0; i < plan.uploads.length; i++) {
    const item = plan.uploads[i];
    try {
      if (item.size > maxUploadBytes) {
        throw new Error(`文件 ${(item.size / 1048576).toFixed(1)}MB 超过上传上限（${(maxUploadBytes / 1048576).toFixed(0)}MB），暂不支持`);
      }
      const buffer = await adapter.readBinary(item.path);
      if (buffer.byteLength !== item.size) {
        throw new Error(`文件在扫描后发生变化（${buffer.byteLength}/${item.size}），请重新同步`);
      }
      const sha = item.sha256 ?? (await sha256Buffer(buffer));
      if (item.sha256 && sha && item.sha256 !== sha) {
        throw new Error("本地文件在扫描后发生变化，请重新同步");
      }

      const uploadId = await remote.initUpload(item.path, item.size, sha);
      for (let offset = 0; offset < item.size; offset += chunkBytes) {
        const len = Math.min(chunkBytes, item.size - offset);
        const chunk = buffer.slice(offset, offset + len);
        await remote.uploadChunk(uploadId, offset, chunk);
        options.onProgress?.({ done, total, label: `${item.path}@${offset}`, bytes });
      }
      const finished = await remote.finishUpload(uploadId);
      if (finished.size !== item.size) {
        throw new Error(`服务端大小不符：${finished.size}/${item.size}`);
      }
      if (sha && finished.sha256 && sha !== finished.sha256) {
        throw new Error("服务端内容哈希不一致");
      }
      bytes += item.size;
      appliedUploads.push({ ...item, sha256: sha });
    } catch (err: any) {
      errors.push({ path: item.path, message: String((err && err.message) || err) });
    } finally {
      done++;
      options.onProgress?.({ done, total, label: item.path, bytes });
    }
  }

  for (const path of plan.deleteRemote) {
    try {
      await remote.deleteRemote(path);
      appliedDeletes.push(path);
    } catch (err: any) {
      errors.push({ path, message: String((err && err.message) || err) });
    } finally {
      done++;
      options.onProgress?.({ done, total, label: `删除远端 ${path}`, bytes });
    }
  }

  const unchangedRemote = options.remoteEntries.filter((entry) =>
    plan.unchangedPaths.includes(entry.path)
  );

  return {
    appliedDownloads: appliedUploads,
    appliedDeletes,
    errors,
    bytes,
    newBaseline: updateBaseline(baseline, appliedUploads, appliedDeletes, unchangedRemote),
  };
}

async function ensureDir(adapter: EngineAdapter, dir: string): Promise<void> {  if (!dir || dir === ".") return;
  const parts = dir.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current);
    }
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}
