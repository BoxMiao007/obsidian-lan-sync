# LAN Sync · 局域网同步（Obsidian 插件）

同一 Wi-Fi 下在电脑与手机之间同步 Obsidian 库，不经过任何云服务。

> 当前版本 **0.0.1（spike）**：只做网络能力自检——验证安卓端 Obsidian 能否用明文 HTTP 连上电脑、能否稳定下载/上传分块数据、能否把分块写进库内临时目录。**还不会同步任何笔记。**

## 为什么需要这个插件

现有同步方式（obsidian-git、坚果云 WebDAV）都要经过外网。在无外网/内网环境，或者手机端不想手动 commit/push 时，需要一个「打开 Obsidian 点一下就在同一 Wi-Fi 内完成同步」的方案。

## 架构约束（决定了它长什么样）

- **手机不能当服务器**：Obsidian 手机端是 Capacitor WebView，没有 Node，插件也无法携带原生代码。因此只能是电脑监听、手机主动连接。
- **电脑端 Obsidian 必须开着**：插件运行在 Obsidian 进程内，Obsidian 关闭则服务停止。
- **大文件必须分块**：手机端 `readBinary`/`writeBinary`/`requestUrl` 都是整包缓冲，20–50MB 就可能 OOM 崩掉 Obsidian。

## 开发

```bash
pnpm install
pnpm build      # 产出 main.js
pnpm test:server # 用 Node 直接验证服务端协议
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<库>/.obsidian/plugins/lan-sync/`，重启 Obsidian 并在「第三方插件」里启用。

## Spike 自检步骤

1. 电脑端启用插件 → 设置页确认「服务端运行中」，记下 `http://192.168.x.x:28900` 和配对码。
2. 手机端把插件文件放进同一个库的 `.obsidian/plugins/lan-sync/`，启用插件。
3. 手机端设置页填「电脑 IP」「端口」「配对码」，点「完整自检」。
4. 把弹出的报告贴回给助手。

## 目录

```
src/server.ts   桌面端 HTTP 服务（Node，函数内 require，避免手机端加载崩溃）
src/client.ts   客户端请求能力（requestUrl / fetch / 分块下载 / 写盘 / 上传）
src/main.ts     插件入口、自检编排、报告弹窗
src/settings.ts 设置页
tests/          服务端协议测试（Node 直跑，不依赖 Obsidian）
```
