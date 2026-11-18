/**
 * 执行层：把「同步计划」变成真实的文件读写。
 * 只依赖适配器接口，方便用 Node 假适配器做端到端测试。
 */
import type { ManifestAdapter } from "./manifest";
import type { Baseline, FileEntry } from "./types";
import { updateBaseline, type ChangeItem, type ConflictItem, type SyncPlan } from "./plan";
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

      if (item.size === 0) {
        // 空文件不会产生任何分块，必须显式写一个空文件，否则 tmp 文件根本不存在
        await adapter.writeBinary(tmpPath, new ArrayBuffer(0));
        first = false;
      }

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
      if (!stat || stat.size !== item.size) throw new Error(`临时文件大小异常：${stat?.size}/${item.size}`);

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

export type ConflictChoice = "remote" | "local" | "both";

export interface ConflictApplyOptions {
  chunkBytes?: number;
  /** 传输中间文件目录（库内） */
  tmpDir: string;
  /** 保留两份时，本机副本的文件名生成器 */
  makeCopyPath: (path: string) => string;
  onProgress?: (label: string) => void;
}

export interface ConflictApplyResult {
  newBaseline: Baseline;
  copyPath?: string;
  errors: string[];
}

/**
 * 冲突三选一。
 * - remote：用电脑版本覆盖本机
 * - local：用本机版本覆盖电脑
 * - both：先备份本机版本为冲突副本，再用电脑版本覆盖原文件（副本会在下次同步上传）
 */
export async function applyConflictChoice(
  adapter: EngineAdapter,
  downloader: FileDownloader,
  writer: RemoteWriter,
  conflict: ConflictItem,
  choice: ConflictChoice,
  baseline: Baseline,
  options: ConflictApplyOptions
): Promise<ConflictApplyResult> {
  const errors: string[] = [];
  let copyPath: string | undefined;

  if (choice === "both") {
    if (conflict.localSha === null && !(await adapter.exists(conflict.path))) {
      return { newBaseline: baseline, errors: ["本机文件已不存在"] };
    }
    try {
      const data = await adapter.readBinary(conflict.path);
      copyPath = options.makeCopyPath(conflict.path);
      await ensureDir(adapter, dirname(copyPath));
      await adapter.writeBinary(copyPath, data);
    } catch (err: any) {
      return { newBaseline: baseline, errors: [`备份冲突副本失败：${(err && err.message) || err}`] };
    }
  }

  if (choice === "remote" || choice === "both") {
    const plan = conflictPlan({ downloads: [conflictToItem(conflict, "remote")] });
    const result = await applyPullPlan(adapter, downloader, plan, baseline, {
      tmpDir: options.tmpDir,
      remoteEntries: [],
      onProgress: () => options.onProgress?.(`写入 ${conflict.path}`),
    });
    for (const item of result.errors) errors.push(item.message);
    return { newBaseline: result.newBaseline, copyPath, errors };
  }

  const plan = conflictPlan({ uploads: [conflictToItem(conflict, "local")] });
  const result = await applyPushPlan(adapter, writer, plan, baseline, {
    chunkBytes: options.chunkBytes,
    remoteEntries: [],
    onProgress: () => options.onProgress?.(`上传 ${conflict.path}`),
  });
  for (const item of result.errors) errors.push(item.message);
  return { newBaseline: result.newBaseline, errors };
}

function conflictToItem(conflict: ConflictItem, side: "remote" | "local"): ChangeItem {
  return side === "remote"
    ? { path: conflict.path, size: conflict.remoteSize, sha256: conflict.remoteSha, mtime: 0 }
    : { path: conflict.path, size: conflict.localSize, sha256: conflict.localSha, mtime: 0 };
}

function conflictPlan(parts: { downloads?: ChangeItem[]; uploads?: ChangeItem[] }): SyncPlan {
  return {
    downloads: parts.downloads ?? [],
    uploads: parts.uploads ?? [],
    deleteLocal: [],
    deleteRemote: [],
    conflicts: [],
    skipped: [],
    unchanged: 0,
    unchangedPaths: [],
    breaker: null,
    totals: { localFiles: 0, remoteFiles: 0 },
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
