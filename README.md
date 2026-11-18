# LAN Sync · 局域网同步（Obsidian 插件）

同一 Wi-Fi 下在电脑与手机之间同步 Obsidian 库，不经过任何云服务。

## 当前状态：v0.3（双向同步，可用）

- ✅ 桌面端 HTTP 服务（Obsidian 开着时监听，默认端口 28900）
- ✅ 手机端与电脑端双向同步：内容哈希基线 + 4MB 分块传输 + 原子落盘
- ✅ 忽略规则：`.git` / `.trash` / `workspace*.json` / 本插件自身目录 / **第三方插件的 data.json**（默认，含凭据）
- ✅ 删除传播（双向）+ 删除熔断（>20 个或 >30% 时中止）
- ✅ 冲突弹窗：逐条选「留电脑 / 留手机 / 两份都留」
- ✅ 首次同步强制预览（干跑），覆盖/删除前自动备份到 `.trash/lan-sync-backup-*`
- ✅ 自动同步开关：总开关 / 打开 app 同步 / 文件变更防抖 / 定时同步
- ✅ 测试：core 16 项 + server 11 项 + e2e 5 项
- ⏳ 待做：真机验证（手机端）、BRAT 发版（需要 GitHub 仓库）

## 架构约束（决定了它长什么样）

- **手机不能当服务器**：Obsidian 手机端是 Capacitor WebView，没有 Node，插件也无法携带原生代码。因此只能是电脑监听、手机主动连接。
- **电脑端 Obsidian 必须开着**：插件运行在 Obsidian 进程内，Obsidian 关闭则服务停止。
- **大文件必须分块**：手机端 `readBinary`/`writeBinary`/`requestUrl` 都是整包缓冲，20–50MB 就可能 OOM 崩掉 Obsidian。
- **明文 HTTP 只在安卓当前版本可用**：iOS 已被 ATS 封死；安卓属于过渡期机制，未来可能要切换自签 HTTPS。

## 安装（BRAT）

1. 把本仓库推到 GitHub（`.github/workflows/release.yml` 会在打 tag 时自动构建并挂出三个文件）。
2. 手机端装 BRAT 插件 → Add Beta plugin → 填 `你的用户名/obsidian-lan-sync`。
3. 或者手动：把 `main.js` / `manifest.json` / `styles.css` 放进 `<库>/.obsidian/plugins/lan-sync/`。

## 安全边界

- 只监听局域网，配对码错误一律 401；请求体带 `x-lan-sync-token`。
- **明文 HTTP**：同 Wi-Fi 下可被抓包。因此默认**不同步**任何第三方插件的 `data.json`——本库的坚果云 WebDAV 凭据、obsidian-git 的 GitHub 令牌都在里面。设置里那个「同步第三方插件设置（危险）」开关默认关闭。
- `.git`、`.trash`、`workspace*.json`、`*.askpass.sh` 和本插件自身目录永不同步。
- 同一时刻只允许一个客户端同步（服务端会话锁，1 小时超时兜底）。

## 开发

```bash
pnpm install
pnpm build        # 产出 main.js
pnpm test         # core + server + e2e 共 31 项
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
src/net/remote.ts  手机端 HTTP 客户端（requestUrl）
src/server.ts      桌面端 HTTP 服务（Node，函数内 require）
src/client.ts      spike 自检用的请求/写盘探测
src/main.ts        插件入口、命令、预览与报告弹窗
src/settings.ts    设置页
tests/             core / server / e2e
```

## 同步语义

- 判据：**内容哈希**。mtime 只做展示与缓存失效，坚果云/git 改写时间戳不会产生假变更。
- 基线：`<插件目录>/baseline.json`，记录上次成功同步后的共同状态（不参与同步）。
- 冲突：两端都改过 → 不覆盖、不合并，本次跳过并在结果里列出（v0.3 做弹窗三选一）。
- 删除：基线确认过的删除才传播；超过阈值整体中止。
