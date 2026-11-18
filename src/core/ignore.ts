/**
 * 同步忽略规则。客户端和桌面服务端共用同一份实现，
 * 否则两端对「哪些文件该传」的判断会不一致，产生幽灵变更。
 */

export interface IgnoreConfig {
  /** Obsidian 配置目录，通常 ".obsidian"，用户可自定义 */
  configDir: string;
  /** 本插件 id；传入后整个插件目录都不参与同步（含 data.json 里的配对码） */
  selfPluginId?: string;
  /** 额外忽略模式，支持 ** / * / ? */
  extraPatterns?: string[];
}

/** 统一成 POSIX 风格相对路径：反斜杠转正斜杠、去掉前导 ./ 和 / */
export function normalizeVaultPath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

const ALWAYS_IGNORED_PREFIXES = [".git/", ".trash/"];
const ALWAYS_IGNORED_FILES = new Set([
  ".git",
  ".trash",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".gitignore.bak",
]);

export function isIgnored(path: string, config: IgnoreConfig): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized) return true;

  if (ALWAYS_IGNORED_FILES.has(normalized)) return true;
  for (const prefix of ALWAYS_IGNORED_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return true;
  }

  const configDir = normalizeVaultPath(config.configDir || ".obsidian");
  // 配置目录本身要允许遍历（只排除其中特定文件），否则 .obsidian/app.json 也会被跳过

  // 工作区文件：两端布局本就不同，同步只会互相覆盖
  if (normalized === `${configDir}/workspace.json`) return true;
  if (normalized === `${configDir}/workspace-mobile.json`) return true;

  // 本插件自身目录：data.json 里是配对码，tmp/ 里是传输中间文件
  if (config.selfPluginId) {
    const selfDir = `${configDir}/plugins/${config.selfPluginId}`;
    if (normalized === selfDir || normalized.startsWith(`${selfDir}/`)) return true;
  }

  for (const pattern of config.extraPatterns || []) {
    if (!pattern) continue;
    if (globToRegExp(pattern).test(normalized)) return true;
  }

  return false;
}

export function filterIgnored<T extends { path: string }>(entries: T[], config: IgnoreConfig): T[] {
  return entries.filter((entry) => !isIgnored(entry.path, config));
}

const globCache = new Map<string, RegExp>();

/** 只支持 ** / * / ? 的最小实现，够覆盖「忽略某某目录」这类配置。 */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  let out = "^";
  // 不含斜杠的模式按 gitignore 惯例匹配任意层级（*.tmp 等价于 **/*.tmp）
  if (!pattern.includes("/")) out += "(?:.*/)?";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += "$";
  const regexp = new RegExp(out);
  globCache.set(pattern, regexp);
  return regexp;
}