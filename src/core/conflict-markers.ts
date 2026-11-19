/**
 * 检测文本里是否存在「未解决的合并冲突标记」。
 *
 * 为什么会需要这个：本库同时装着坚果云（nutstore-sync），它开启
 * "useGitStyle" 后会把合并失败的文件写成 `<<<<<<<` / `=======` / `>>>>>>>`
 * 标记（不带分支名，和 git 的标准输出不同）。
 * 局域网同步本身不做文本合并，如果照原样搬运这类文件，脏内容会在两台设备间扩散。
 * 所以清单阶段就把它们标出来，同步时跳过，并提示用户先手动解决。
 */

const START = "<<<<<<<";
const MID = "=======";
const END = ">>>>>>>";

/** 二进制文件（含 NUL 字节）不做文本检测。 */
export function detectConflictMarkers(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  const limit = Math.min(bytes.length, 512 * 1024);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return false;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limit));
  } catch {
    return false;
  }
  return textHasConflictMarkers(text);
}

export function textHasConflictMarkers(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let startIndex = -1;
  let middleIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (startIndex < 0) {
      if (line.startsWith(START)) startIndex = i;
      continue;
    }
    if (middleIndex < 0) {
      if (line.startsWith(MID)) middleIndex = i;
      continue;
    }
    if (line.startsWith(END)) return true;
  }
  return false;
}
