/**
 * 同步计划计算：纯函数，不碰文件系统、不碰网络。
 *
 * 三方比较：base（上次同步基线） / local（本机） / remote（对端）。
 * 这是整个插件最容易丢数据的地方，所以单独抽出来做穷举单测。
 */
import type { Baseline, FileEntry } from "./types";
import { entryMap } from "./types";

export type PlanMode = "pull" | "push" | "both";

export type NoBaseStrategy = "conflict" | "prefer-remote" | "prefer-local";

export interface PlanOptions {
  /** pull = 只把远端改动落到本机；push = 只把本机改动推到远端；both = 双向 */
  mode: PlanMode;
  /** 一次同步允许的最大删除数，默认 20 */
  maxDeletes?: number;
  /** 一次同步允许的最大删除比例，默认 0.3（30%） */
  maxDeleteRatio?: number;
  /**
   * 没有基线时两边都有同一文件且内容不同，怎么处理。
   * 默认 conflict（最安全）；首次同步时用户可显式选 prefer-remote / prefer-local。
   */
  noBaseStrategy?: NoBaseStrategy;
}

export interface ChangeItem {
  path: string;
  size: number;
  sha256: string | null;
  mtime: number;
}

export interface ConflictItem {
  path: string;
  reason: "both-modified" | "no-base" | "diverged";
  localSha: string | null;
  remoteSha: string | null;
  localSize: number;
  remoteSize: number;
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface SyncPlan {
  downloads: ChangeItem[];
  uploads: ChangeItem[];
  deleteLocal: string[];
  deleteRemote: string[];
  conflicts: ConflictItem[];
  skipped: SkippedItem[];
  unchanged: number;
  unchangedPaths: string[];
  breaker: null | { message: string; deletes: number; total: number };
  totals: { localFiles: number; remoteFiles: number };
}

export function planSync(
  local: FileEntry[],
  remote: FileEntry[],
  baseline: Baseline,
  options: PlanOptions
): SyncPlan {
  const localMap = entryMap(local);
  const remoteMap = entryMap(remote);
  const base = baseline.entries || {};

  const plan: SyncPlan = {
    downloads: [],
    uploads: [],
    deleteLocal: [],
    deleteRemote: [],
    conflicts: [],
    skipped: [],
    unchanged: 0,
    unchangedPaths: [],
    breaker: null,
    totals: { localFiles: localMap.size, remoteFiles: remoteMap.size },
  };

  const paths = Array.from(new Set([...localMap.keys(), ...remoteMap.keys()])).sort();

  for (const path of paths) {
    const l = localMap.get(path);
    const r = remoteMap.get(path);
    const b = base[path];

    // 含未解决冲突标记的文件（坚果云/git 留下的 <<<<<<< 块）一律不碰：
    // 两端都不动它，避免脏内容扩散；由用户先手动解决。
    if ((l && l.unsafe) || (r && r.unsafe)) {
      plan.skipped.push({
        path,
        reason: "文件含未解决的合并冲突标记（<<<<<<<），请先手动处理",
      });
      continue;
    }

    if (l && r) {
      if (sameContent(l, r)) {
        plan.unchanged++;
        plan.unchangedPaths.push(path);
        continue;
      }
      if (!b) {
        const strategy = options.noBaseStrategy ?? "conflict";
        if (strategy === "prefer-remote") {
          plan.downloads.push(toItem(r));
        } else if (strategy === "prefer-local") {
          plan.uploads.push(toItem(l));
        } else {
          plan.conflicts.push(conflict("no-base", l, r));
        }
        continue;
      }
      const localChanged = changedSinceBase(l, b);
      const remoteChanged = changedSinceBase(r, b);
      if (localChanged && remoteChanged) {
        plan.conflicts.push(conflict("both-modified", l, r));
      } else if (localChanged) {
        plan.uploads.push(toItem(l));
      } else if (remoteChanged) {
        plan.downloads.push(toItem(r));
      } else {
        plan.conflicts.push(conflict("diverged", l, r));
      }
      continue;
    }

    if (l && !r) {
      if (b) {
        // 远端删除了这个文件 → 本机也应删除
        plan.deleteLocal.push(path);
      } else {
        // 本机新增
        plan.uploads.push(toItem(l));
      }
      continue;
    }

    if (!l && r) {
      if (b) {
        // 本机删除了这个文件 → 远端也应删除
        plan.deleteRemote.push(path);
      } else {
        // 远端新增
        plan.downloads.push(toItem(r));
      }
    }
  }

  applyMode(plan, options.mode);
  applyBreaker(plan, options, Object.keys(base).length);
  return plan;
}

function applyMode(plan: SyncPlan, mode: PlanMode): void {
  if (mode === "both") return;

  const dropUploads = mode === "pull";
  if (dropUploads) {
    for (const item of plan.uploads) {
      plan.skipped.push({ path: item.path, reason: "本机新增/修改：v0.1 只拉取，不推送回电脑" });
    }
    for (const path of plan.deleteRemote) {
      plan.skipped.push({ path, reason: "本机删除：只拉取模式下不删除电脑上的文件" });
    }
    plan.uploads = [];
    plan.deleteRemote = [];
    return;
  }

  // push 模式
  for (const item of plan.downloads) {
    plan.skipped.push({ path: item.path, reason: "远端新增/修改：只推送模式不写入本机" });
  }
  for (const path of plan.deleteLocal) {
    plan.skipped.push({ path, reason: "远端删除：只推送模式不删除本机文件" });
  }
  plan.downloads = [];
  plan.deleteLocal = [];
}

function applyBreaker(plan: SyncPlan, options: PlanOptions, baselineCount: number): void {
  const deletes = plan.deleteLocal.length + plan.deleteRemote.length;
  if (deletes === 0) return;

  const total = new Set([
    ...plan.downloads.map((d) => d.path),
    ...plan.uploads.map((u) => u.path),
    ...plan.deleteLocal,
    ...plan.deleteRemote,
    ...plan.conflicts.map((c) => c.path),
  ]).size + plan.unchanged;

  const maxDeletes = options.maxDeletes ?? 20;
  const maxRatio = options.maxDeleteRatio ?? 0.3;
  const ratio = total > 0 ? deletes / total : 0;
  // 小库不适用「占全库比例」阈值：3 个文件删 1 个就是 33%，属于正常操作
  const ratioApplies = total >= 20;
  // 但小库也要防「另一端莫名其妙空掉」：删除超过基线的一半且至少 3 个，就拦下来
  const baselineHeavy = baselineCount > 0 && deletes >= 3 && deletes / baselineCount > 0.5;

  if (deletes > maxDeletes || (ratioApplies && ratio > maxRatio) || baselineHeavy) {
    plan.breaker = {
      message: `本次同步要删除 ${deletes} 个文件（共 ${total} 个，占 ${(ratio * 100).toFixed(0)}%；基线 ${baselineCount} 个），超过安全阈值（>${maxDeletes} 个${ratioApplies ? `或 >${(maxRatio * 100).toFixed(0)}%` : ""}，或删除超过基线半数）。已中止，请检查电脑端库路径是否配错、是否换机/清空目录后重试。`,
      deletes,
      total,
    };
  }
}

function sameContent(
  a: { sha256: string | null; size: number },
  b: { sha256: string | null; size: number }
): boolean {
  if (a.sha256 && b.sha256) return a.sha256 === b.sha256;
  return a.size === b.size;
}

function changedSinceBase(
  entry: { sha256: string | null; size: number },
  base: { sha256: string | null; size: number }
): boolean {
  if (base.sha256 && entry.sha256) return entry.sha256 !== base.sha256;
  return entry.size !== base.size;
}

function toItem(entry: FileEntry): ChangeItem {
  return { path: entry.path, size: entry.size, sha256: entry.sha256, mtime: entry.mtime };
}

function conflict(reason: ConflictItem["reason"], l: FileEntry, r: FileEntry): ConflictItem {
  return {
    path: l.path,
    reason,
    localSha: l.sha256,
    remoteSha: r.sha256,
    localSize: l.size,
    remoteSize: r.size,
  };
}

/** 执行成功后更新基线。只记录真正处于「双方一致」状态的文件。 */
export function updateBaseline(
  baseline: Baseline,
  appliedDownloads: ChangeItem[],
  appliedDeletes: string[],
  remoteUnchanged: FileEntry[],
  now = Date.now()
): Baseline {
  const entries = { ...baseline.entries };
  for (const item of appliedDownloads) {
    entries[item.path] = { size: item.size, sha256: item.sha256 };
  }
  for (const path of appliedDeletes) {
    delete entries[path];
  }
  for (const entry of remoteUnchanged) {
    entries[entry.path] = { size: entry.size, sha256: entry.sha256 };
  }
  return { version: 1, updatedAt: now, entries };
}

/**
 * 自动同步是否可以不经确认直接执行。
 * 首次同步（基线为空）、存在冲突、或触发删除熔断时必须让用户确认——
 * 无人值守的自动同步绝不能在这些情况下擅自写文件。
 */
export function requiresConfirmation(
  plan: SyncPlan,
  baseline: Baseline
): { required: boolean; reason: string | null } {
  if (plan.breaker) return { required: true, reason: "触发删除保护" };
  if (plan.conflicts.length > 0) {
    return { required: true, reason: `有 ${plan.conflicts.length} 个冲突待处理` };
  }
  if (baseline.updatedAt === 0) return { required: true, reason: "这是首次同步，需要先确认" };
  return { required: false, reason: null };
}

/** 计划里是否有任何需要处理的动作（冲突也算）。 */
export function planHasWork(plan: SyncPlan): boolean {
  return (
    plan.downloads.length +
      plan.uploads.length +
      plan.deleteLocal.length +
      plan.deleteRemote.length +
      plan.conflicts.length >
    0
  );
}

export function summarizePlan(plan: SyncPlan): string {
  const parts = [
    `下载 ${plan.downloads.length}`,
    `删除本机 ${plan.deleteLocal.length}`,
    `冲突 ${plan.conflicts.length}`,
    `跳过 ${plan.skipped.length}`,
    `未变 ${plan.unchanged}`,
  ];
  return parts.join(" · ");
}