/**
 * 生成库的文件清单（manifest）。
 * 与 Obsidian 解耦：只依赖 DataAdapter 的一个子集，便于用 Node 假适配器做端到端测试。
 */
import { sha256Buffer } from "./hash";
import { detectConflictMarkers } from "./conflict-markers";
import { isIgnored, type IgnoreConfig } from "./ignore";
import type { FileEntry, Manifest } from "./types";

export interface ManifestAdapter {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: string; size: number; mtime: number; ctime: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export interface ManifestOptions {
  ignore: IgnoreConfig;
  /** 超过这个大小就不算哈希（手机读整文件会 OOM），默认 24MB */
  maxHashBytes?: number;
  hasher?: (buffer: ArrayBuffer) => Promise<string | null>;
  onProgress?: (info: { scanned: number; hashed: number; current: string }) => void;
}

export async function buildManifest(
  adapter: ManifestAdapter,
  options: ManifestOptions
): Promise<Manifest> {
  const ignore = options.ignore;
  const maxHashBytes = options.maxHashBytes ?? 24 * 1024 * 1024;
  const hasher = options.hasher ?? sha256Buffer;

  const files: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const listing = await adapter.list(dir);
    for (const file of listing.files) {
      if (!isIgnored(file, ignore)) files.push(file);
    }
    for (const folder of listing.folders) {
      if (isIgnored(folder, ignore)) continue;
      await walk(folder);
    }
  };

  await walk("");
  files.sort();

  const entries: FileEntry[] = [];
  let hashed = 0;
  for (const path of files) {
    const stat = await adapter.stat(path);
    if (!stat || stat.type !== "file") continue;
    const size = stat.size;
    let sha256: string | null = null;
    let unsafe = false;
    if (size <= maxHashBytes) {
      try {
        const buffer = await adapter.readBinary(path);
        sha256 = await hasher(buffer);
        unsafe = detectConflictMarkers(buffer);
        hashed++;
      } catch {
        sha256 = null;
      }
    }
    entries.push({
      path,
      size,
      mtime: Math.trunc(stat.mtime || 0),
      sha256,
      unsafe,
    });
    options.onProgress?.({ scanned: entries.length, hashed, current: path });
  }

  return { generatedAt: Date.now(), entries };
}

export function manifestToJSON(manifest: Manifest): string {
  return JSON.stringify({ generatedAt: manifest.generatedAt, entries: manifest.entries });
}
