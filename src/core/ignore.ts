/**
 * 同步忽略规则。客户端和桌面服务端共用同一份实现，
 * 否则两端对「哪些文件该传」的判断会不一致，产生幽灵变更。
 */

export interface IgnoreConfig {
  /** Obsidian 配置目录，通常 ".obsidian"，用户可自定义 */
  configDir: string;
  /** 本插件 id；用于识别自身目录下哪些文件不能同步 */
  selfPluginId?: string;
  /** 额外忽略模式，支持 ** / * / ? */
  extraPatterns?: string[];
  /**
   * 是否同步各插件的 data.json。默认 false：
   * 这些文件里常有第三方服务的密码或令牌（本库的 nutstore-sync、obsidian-git 都有），
   * 明文 HTTP 传出去等于裸奔。
   */
  syncPluginData?: boolean;
  /**
   * 是否同步本插件的程序文件（main.js / manifest.json / styles.css）。
   * 默认 true：这样电脑上更新插件后，手机能自动跟上，不用每次手动拷。
   * 注意：本插件的 data.json / baseline.json / tmp/ 永远不同步。
   */
  syncSelfCode?: boolean;
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

  // 本插件自身目录：只放行程序文件，其余（配对码、基线、临时文件）一律不同步。
  // 配对码两端必须不同、基线每端独立、tmp 是传输中间产物，同步它们必然互相破坏。
  if (config.selfPluginId) {
    const selfDir = `${configDir}/plugins/${config.selfPluginId}`;
    if (normalized === selfDir || normalized.startsWith(`${selfDir}/`)) {
      // 未显式关闭即视为开启（与设置项默认值一致）
      if (config.syncSelfCode === false) return true;
      const relative = normalized.slice(selfDir.length + 1);
      // 只允许顶层三件套，且不允许子孙目录（tmp/、backup/ 等）
      return !SELF_CODE_FILES.has(relative);
    }
  }

  // 插件设置文件默认不同步：里面常有第三方服务凭据
  if (!config.syncPluginData && isPluginDataFile(normalized, configDir)) return true;

  // 桌面端的 git 凭据助手脚本，手机端没有意义且涉及凭据流程
  if (normalized.endsWith("askpass.sh")) return true;

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

/** 本插件唯一允许参与同步的文件：程序三件套。 */
const SELF_CODE_FILES = new Set(["main.js", "manifest.json", "styles.css"]);

function isPluginDataFile(path: string, configDir: string): boolean {
  const prefix = `${configDir}/plugins/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  const parts = rest.split("/");
  return parts.length === 2 && parts[1] === "data.json";
}

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