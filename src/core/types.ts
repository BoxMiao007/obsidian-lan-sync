/** 同步核心的公共类型。纯数据，不依赖 Obsidian 与 Node。 */

export interface FileEntry {
  /** 库内相对路径，统一用正斜杠 */
  path: string;
  size: number;
  /** 整数毫秒；只用于展示与缓存失效，不作为变更判据 */
  mtime: number;
  /** 内容哈希；超大文件可能为 null（此时退化为按大小比较） */
  sha256: string | null;
  /** 文件里存在未解决的合并冲突标记（如坚果云/git 留下的 <<<<<<< 块），不参与同步 */
  unsafe?: boolean;
}

export interface Manifest {
  generatedAt: number;
  entries: FileEntry[];
}

export interface BaselineEntry {
  size: number;
  sha256: string | null;
}

/**
 * 基线 = 上次成功同步后双方的共同状态（三方合并里的 base）。
 * 用本机路径作键；只存哈希和大小，不存 mtime（mtime 会被各种工具改写）。
 */
export interface Baseline {
  version: 1;
  updatedAt: number;
  entries: Record<string, BaselineEntry>;
  /** 该基线对应的远端身份（如 webdav:http://ip:8080/库名 或 http://ip:28900）；变化时自动重置 */
  remote?: string;
}

export function emptyBaseline(): Baseline {
  return { version: 1, updatedAt: 0, entries: {} };
}

export function entryMap(entries: FileEntry[]): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const entry of entries) map.set(entry.path, entry);
  return map;
}