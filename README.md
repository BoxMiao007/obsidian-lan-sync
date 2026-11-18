# LAN Sync · 局域网同步（Obsidian 插件）

同一 Wi-Fi 下在电脑与手机之间同步 Obsidian 库，不经过任何云服务。

## 当前状态：v0.1（单向：电脑 → 手机）

- ✅ 桌面端 HTTP 服务（Obsidian 开着时监听，默认端口 28900）
- ✅ 手机端「从电脑同步到本机」：内容哈希基线 + 4MB 分块传输 + 原子落盘
- ✅ 忽略规则：`.git` / `.trash` / `workspace*.json` / 本插件自身目录
- ✅ 删除传播 + 删除熔断（>20 个或 >30% 时中止）
- ✅ 首次同步强制预览（干跑），覆盖/删除前自动备份到 `.trash/lan-sync-backup-*`
- ✅ 单元测试 + 端到端测试（真实 HTTP + 真实文件系统）
- ⏳ 待做：手机 → 电脑推送（v0.2）、双向 + 冲突弹窗（v0.3）、BRAT 发布

## 架构约束（决定了它长什么样）

- **手机不能当服务器**：Obsidian 手机端是 Capacitor WebView，没有 Node，插件也无法携带原生代码。因此只能是电脑监听、手机主动连接。
- **电脑端 Obsidian 必须开着**：插件运行在 Obsidian 进程内，Obsidian 关闭则服务停止。
- **大文件必须分块**：手机端 `readBinary`/`writeBinary`/`requestUrl` 都是整包缓冲，20–50MB 就可能 OOM 崩掉 Obsidian。
- **明文 HTTP 只在安卓当前版本可用**：iOS 已被 ATS 封死；安卓属于过渡期机制，未来可能要切换自签 HTTPS。

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
