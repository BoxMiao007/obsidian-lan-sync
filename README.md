# LAN Sync · 局域网同步（Obsidian 插件）

同一 Wi-Fi 下在电脑与手机之间同步 Obsidian 库，不经过任何云服务。

## 当前状态：v0.7（WebDAV 优先 + 电脑兜底）

- ✅ **WebDAV 中转（推荐）**：电脑与手机两个 Obsidian 插件都连手机上的 rclone WebDAV 同步；电脑无需再当常驻服务器
- ✅ 电脑端 HTTP 服务（原模式）保留为**兜底**：手机连不上 WebDAV 时直连电脑
- ✅ 跨设备锁（WebDAV 锁文件 + 租约）避免两端同时写坏；网络失败指数退避
- ✅ 冲突：一端删/另一端改 → **编辑优先重建**（不再静默丢改）；两端都改 → 默认**自动留两份（本机优先）**，可在设置里切回「留电脑/留手机/两份都留」复核
- ✅ 桌面端 HTTP 服务（Obsidian 开着时监听，默认端口 28900）
- ✅ 手机端与电脑端双向同步：内容哈希基线 + 4MB 分块传输 + 原子落盘
- ✅ 同步入口：侧栏 ⇅ 按钮 + 状态栏 + 命令面板
- ✅ 忽略规则：`.git` / `.trash` / `workspace*.json` / **第三方插件的 data.json**（默认，含凭据）
- ✅ 本插件程序文件可随同步自动更新（`data.<desktop|mobile>.json`/基线/`sync-cache.json`/`tmp` 始终排除）
  - 注意：更新通道只选一个。用 BRAT 更新就把它关掉，避免两端互相覆盖。
- ✅ 删除传播（双向）+ 删除熔断（>20 个或 >30% 时中止）
- ✅ 冲突弹窗：逐条选「留电脑 / 留手机 / 两份都留」
- ✅ 含未解决冲突标记（`<<<<<<<`，坚果云/git 遗留）的文件自动跳过并提示，不再扩散脏内容
- ✅ 首次同步强制预览（干跑），覆盖/删除前自动备份到 `.trash/lan-sync-backup-*`
- ✅ 自动同步开关：总开关 / 打开 app 同步 / 文件变更防抖 / 定时同步
- ✅ 测试：core 25 项 + webdav 10 项 + server 14 项 + e2e 13 项（共 62）
- ✅ 通知：一切结果走右上角提示，不弹中心弹窗；冲突与删除保护例外（必须交互确认）
- ✅ 覆盖/删除前，本机与电脑端文件都会先备份到 `.trash/lan-sync-backup-*`
- ⏳ 待做：手机端真机验证

## 架构约束（决定了它长什么样）

- **手机不能当服务器**：Obsidian 手机端是 Capacitor WebView，没有 Node，插件也无法携带原生代码。因此只能是电脑监听、手机主动连接。
- **电脑端 Obsidian 开着才同步电脑侧**：插件跑在 Obsidian 进程内；WebDAV 模式下电脑只是客户端，Obsidian 关闭时电脑侧不同步（不影响手机↔WebDAV）。
- **WebDAV 是哑存储**：没有清单/哈希/锁接口。插件用 `PROPFIND` 列目录、本地哈希缓存（ETag/mtime 命中即复用）、锁文件+租约来补齐；上传用 `PUT 临时文件 + MOVE` 原子替换。
- **大文件必须分块**：手机端 `readBinary`/`writeBinary`/`requestUrl` 都是整包缓冲，20–50MB 就可能 OOM 崩掉 Obsidian。
- **明文 HTTP 只在安卓当前版本可用**：iOS 已被 ATS 封死；安卓属于过渡期机制，未来可能要切换自签 HTTPS。

## WebDAV 配置（v0.6 推荐）

典型拓扑是 **三设备**：`主用手机（Obsidian） ↔ 旧手机（rclone WebDAV，中转） ↔ 电脑（Obsidian）`。旧手机只跑 `rclone serve webdav`（把某目录如 `/sdcard/aaa/webdav` 暴露到 LAN，详见手机侧文档 `docs/WEBDAV.md`），**不装 Obsidian**；两个 Obsidian 客户端都连它的 WebDAV。

在**主用手机**和**电脑**两端 Obsidian 的「WebDAV 中转」里都填：

| 字段 | 主用手机（Obsidian） | 电脑（Obsidian） |
|---|---|---|
| WebDAV 服务器 IP | 旧手机的局域网 IP | 旧手机的局域网 IP |
| 端口 | 8080 | 8080 |
| 用户名/密码 | 与 rclone 一致 | 与 rclone 一致 |
| 路径前缀（可选） | 同一值（留空=直接用库名；库名固定为库文件夹名，两端务必一致） | 同左 |

- **兜底**：主用手机若连不上旧手机 WebDAV，会退回直连电脑 HTTP 服务；因此手机端另需在「客户端 · 网络自检」填电脑 IP（电脑 Obsidian 开着时其服务在）。
- **传输方式**：`自动`（WebDAV 优先，手机连不上时兜底直连电脑 HTTP 服务）/ `只用 WebDAV` / `只用电脑直连`。
- **配置按设备分开存**：每台设备的设置各自存本地的 `data.<desktop|mobile>.json`（不再共用 `data.json`）；旧 `data.json` 首次加载会自动迁移并删除。两份文件互不覆盖，放进库 git 备份也不会冲突。
- 同步读写都在 WebDAV 下的子目录里，`.lansync/lock.json` 是跨设备锁，**不参与同步**；不会误碰 share 里其它文件。
- 想用手动复核冲突：把「冲突自动留两份」关掉，就会弹「留电脑/留手机/两份都留」。

## 安装

### 方式一：BRAT（手机端推荐，可自动更新）

1. 手机端先装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件。
2. BRAT → Add Beta plugin → 填 `BoxMiao007/obsidian-lan-sync` → 添加。
3. 回插件列表启用「LAN Sync · 局域网同步」。

### 方式二：局域网一键安装（首次配对最方便）

电脑端服务启动后，手机浏览器打开设置页显示的那个带 token 的地址，
点「⬇ 一次下载全部（lan-sync.zip）」，解压后把三件套放进 `<库>/.obsidian/plugins/lan-sync/`。

### 方式三：手动

从 [Releases](https://github.com/BoxMiao007/obsidian-lan-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css` 放进插件目录。

## 已知限制

- 手机端无法分块**读取**（Obsidian 适配器只能整包 `readBinary`），所以超过 24MB 的文件两端只能按大小比较，大小相同但内容变了的改动检测不到；超过 32MB 的文件暂不支持从手机上传。
- 手机端 Obsidian 切到后台会被冻结，自动同步只在 app 前台时可靠。
- 电脑端 Obsidian 必须开着，服务才在（兜底模式）；WebDAV 模式下电脑只是客户端。
- **WebDAV 模式**：手机 rclone 默认不支持分段 PUT，手机上传仍受整包内存限制（约 32MB 上限）；超大文件（>24MB）只按大小比较。
- **WebDAV 明文 Basic**：仅限可信 LAN；密码存本机 `data.<设备>.json`（该文件不参与同步）。
- **非原子回退**：个别 WebDAV 服务器不支持 `MOVE` 时，上传会退回普通 `PUT` 覆盖（非原子，写入中途可能被读到半截文件），日志会给出提示；rclone 支持 `MOVE`，正常不触发。
- 明文 HTTP 是安卓当前的过渡特性，未来 Obsidian 若收紧，需要切自签 HTTPS（协议层已隔离，只改 `src/net/remote.ts`）。

## 安全边界

- 只监听局域网，配对码错误一律 401；请求体带 `x-lan-sync-token`。
- **明文 HTTP**：同 Wi-Fi 下可被抓包。因此默认**不同步**任何第三方插件的 `data.json`——本库的坚果云 WebDAV 凭据、obsidian-git 的 GitHub 令牌都在里面。设置里那个「同步第三方插件设置（危险）」开关默认关闭。
- `.git`、`.trash`、`workspace*.json`、`*.askpass.sh` 永不同步；本插件自身的凭据（`data.<设备>.json`）、基线、缓存也永不同步（仅 `main.js`/`manifest.json`/`styles.css` 可随同步更新）。
- 同一时刻只允许一个客户端同步（服务端会话锁，1 小时超时兜底）。

## 开发

```bash
pnpm install
pnpm build        # 产出 main.js
pnpm test         # core + webdav + server + e2e 共 62 项
pnpm serve        # 单独启动服务端（诊断手机浏览器 vs Obsidian）
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<库>/.obsidian/plugins/lan-sync/`，重启 Obsidian 并启用。

## 目录

```
src/core/       同步核心（纯逻辑，可单测）
  ignore.ts     忽略规则（客户端与服务端共用）
  plan.ts       三方差异计算（base/local/remote）
  manifest.ts   文件清单 + 哈希
  engine.ts     执行下载/删除/落盘
src/net/remote.ts  传输层 SyncRemote 接口 + 电脑 HTTP 客户端（requestUrl）
src/net/webdav.ts  WebDAV 客户端适配（requestUrl）
src/net/webdav-protocol.ts  WebDAV 协议逻辑（PROPFIND/GET/PUT+MOVE/COPY/锁，纯逻辑可单测）
src/server.ts      桌面端 HTTP 服务（仅作兜底）
src/client.ts      spike 自检用的请求/写盘探测
src/main.ts        插件入口、命令、同步编排与通知
src/settings.ts    设置页
tests/             core / server / e2e
```

## 同步语义

- 判据：**内容哈希**。mtime 只做展示与缓存失效，坚果云/git 改写时间戳不会产生假变更。
- 基线：`<插件目录>/baseline.json`，记录上次成功同步后的共同状态（不参与同步）；并记录**远端标识**，换远端（如从旧服务器换到 WebDAV）时自动重置并重建基线，避免旧基线把远端当成“全部被删”而误熔断。
- 哈希缓存：`<插件目录>/sync-cache.json`（本机 mtime+size→sha、WebDAV ETag→sha），命中即复用，未变不重读/不下载。
- 冲突（v0.6）：
  - 一端删除、另一端改过 → **编辑优先**，重建被删的一侧（不丢改动）。
  - 两端都改 / 无基线同名不同内容 → 默认**自动留两份**：本机版留原名，对端版存 `<名>.conflict-<设备>-<时间>`，两份都同步回 WebDAV。
  - 关闭自动时会弹「留电脑 / 留手机 / 两份都留」逐条复核。
- 删除：基线确认过的删除才传播；超过阈值整体中止。
