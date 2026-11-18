import {
  App,
  Modal,
  Notice,
  Platform,
  Plugin,
  normalizePath,
} from "obsidian";
import {
  errMsg,
  formatBytes,
  pingWithFetch,
  pingWithRequestUrl,
  downloadInChunks,
  uploadInChunks,
  writeChunksToVault,
  type StepResult,
  type Target,
} from "./client";
import { createSyncServer, type SyncServerHandle } from "./server";
import { DEFAULT_SETTINGS, LanSyncSettingTab, type LanSyncSettings } from "./settings";

export default class LanSyncPlugin extends Plugin {
  settings!: LanSyncSettings;
  server: SyncServerHandle | null = null;
  logs: string[] = [];
  settingsTab: LanSyncSettingTab | null = null;

  private selfTestRunning = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.settingsTab = new LanSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addRibbonIcon("wifi", "局域网同步：网络自检", () => {
      void this.runSelfTest();
    });

    this.addCommand({
      id: "network-self-test",
      name: "网络自检（手机/电脑）",
      callback: () => void this.runSelfTest(),
    });

    this.addCommand({
      id: "restart-server",
      name: "重启局域网服务（仅桌面端）",
      callback: () => void this.restartServer(),
    });

    this.addCommand({
      id: "clean-temp-files",
      name: "清理自检临时文件",
      callback: () => void this.cleanTempFiles(),
    });

    if (Platform.isDesktopApp && this.settings.autoStartServer) {
      try {
        await this.startServer();
      } catch (err) {
        this.log(`服务启动失败：${errMsg(err)}`);
        new Notice(`局域网服务启动失败：${errMsg(err)}`);
      }
    }
  }

  async onunload(): Promise<void> {
    await this.stopServer();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.token) {
      this.settings.token = randomPairCode();
      await this.saveSettings();
    }
    if (!this.settings.clientToken) {
      this.settings.clientToken = this.settings.token;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  log(line: string): void {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    this.logs.push(`[${stamp}] ${line}`);
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    this.settingsTab?.refreshLog();
  }

  tempDir(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/lan-sync/tmp`);
  }

  async startServer(): Promise<void> {
    if (!Platform.isDesktopApp) throw new Error("服务端只能在电脑端运行");
    if (this.server) return;
    const adapter: any = this.app.vault.adapter;
    const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const pluginDir = basePath
      ? `${basePath}/${this.app.vault.configDir}/plugins/lan-sync`
      : undefined;
    this.server = await createSyncServer({
      port: this.settings.port,
      token: this.settings.token,
      uploadDir: this.tempDir(),
      pluginDir,
      log: (line) => this.log(line),
    });
    this.log(`服务端地址：${this.server.urls.join(" | ")}，配对码 ${this.settings.token}`);
    this.settingsTab?.display();
  }

  async stopServer(): Promise<void> {
    if (!this.server) return;
    const handle = this.server;
    this.server = null;
    await handle.close();
    this.log("服务端已停止");
    this.settingsTab?.display();
  }

  async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  /** 自检目标：优先用手填的电脑地址；桌面端本地可直接打 127.0.0.1。 */
  resolveTarget(): Target {
    const host = (this.settings.clientHost || "").trim();
    if (host) {
      const clean = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      const port = this.settings.clientPort || this.settings.port;
      return { base: `http://${clean}:${port}`, token: this.settings.clientToken || this.settings.token };
    }
    if (Platform.isDesktopApp && this.server) {
      return { base: `http://127.0.0.1:${this.server.port}`, token: this.settings.token };
    }
    throw new Error("请先在设置里填写电脑的 IP 地址（手机端必填）");
  }

  async runSelfTest(): Promise<void> {
    if (this.selfTestRunning) {
      new Notice("自检正在运行，请稍候…");
      return;
    }
    this.selfTestRunning = true;
    const notice = new Notice("局域网自检开始…", 4000);
    const results: StepResult[] = [];
    let target: Target | null = null;

    try {
      target = this.resolveTarget();
    } catch (err) {
      this.selfTestRunning = false;
      notice.hide();
      new ReportModal(this.app, buildReport([], null, errMsg(err))).open();
      return;
    }

    const started = Date.now();
    try {
      this.log(`自检开始 → ${target.base}`);

      results.push(await pingWithRequestUrl(target));
      results.push(await pingWithFetch(target));

      const small = await downloadInChunks(target, 1, 1024 * 1024);
      results.push(stripChunks(small));
      if (small.ok) {
        results.push(
          stripChunks(
            await writeChunksToVault(
              this.app,
              `${this.tempDir()}/selftest-1mb.bin`,
              small.chunks
            )
          )
        );
      } else {
        results.push({ name: "写盘 1MB", ok: false, ms: 0, detail: "跳过（下载失败）" });
      }

      const big = await downloadInChunks(target, 8, 4 * 1024 * 1024);
      results.push(stripChunks(big));
      if (big.ok) {
        results.push(
          stripChunks(
            await writeChunksToVault(
              this.app,
              `${this.tempDir()}/selftest-8mb.bin`,
              big.chunks
            )
          )
        );
      } else {
        results.push({ name: "分块写盘 8MB", ok: false, ms: 0, detail: "跳过（下载失败）" });
      }

      results.push(await uploadInChunks(target, 2 * 1024 * 1024, 4 * 1024 * 1024));
    } catch (err) {
      results.push({ name: "自检异常", ok: false, ms: Date.now() - started, detail: errMsg(err) });
    } finally {
      this.selfTestRunning = false;
      notice.hide();
    }

    const report = buildReport(results, target, null);
    this.log(report.split("\n").slice(0, 2).join(" / "));
    new ReportModal(this.app, report).open();
  }

  async cleanTempFiles(): Promise<void> {
    const adapter: any = this.app.vault.adapter;
    const dir = this.tempDir();
    let removed = 0;
    try {
      const listing = await adapter.list(dir);
      for (const file of listing.files || []) {
        await adapter.remove(file);
        removed++;
      }
      for (const folder of listing.folders || []) {
        const sub = await adapter.list(folder);
        for (const file of sub.files || []) {
          await adapter.remove(file);
          removed++;
        }
      }
      new Notice(`已清理 ${removed} 个自检文件`);
    } catch {
      new Notice("没有可清理的临时文件");
    }
  }
}

function stripChunks(result: StepResult): StepResult {
  const { name, ok, ms, detail } = result;
  return { name, ok, ms, detail };
}

function buildReport(results: StepResult[], target: Target | null, fatal: string | null): string {
  const lines: string[] = [];
  const platform = Platform.isAndroidApp
    ? "Android"
    : Platform.isIosApp
    ? "iOS"
    : Platform.isDesktopApp
    ? "桌面端"
    : "未知平台";

  lines.push("LAN Sync · 网络自检报告");
  lines.push(`时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  lines.push(`平台：${platform}`);
  lines.push(`目标：${target ? target.base : "（未设置）"}`);
  lines.push("");
  if (fatal) {
    lines.push(`✗ 无法开始：${fatal}`);
    return lines.join("\n");
  }
  for (const r of results) {
    lines.push(`${r.ok ? "✓" : "✗"} ${r.name}  (${r.ms}ms)`);
    if (r.detail) lines.push(`    ${r.detail}`);
  }
  lines.push("");
  lines.push(`结论：${summarize(results)}`);
  lines.push("");
  lines.push("把这份报告原样贴回给助手即可。");
  return lines.join("\n");
}

function summarize(results: StepResult[]): string {
  const byName = (key: string) => results.find((r) => r.name.includes(key));
  const requestUrl = byName("requestUrl 连通性");
  const fetchPing = byName("fetch 连通性");
  const bigDownload = byName("下载 8MB");
  const bigWrite = byName("写盘 8.00 MB") ?? byName("分块写盘");

  if (requestUrl && !requestUrl.ok && fetchPing && !fetchPing.ok) {
    return "两种请求方式都不通。先确认同一 Wi-Fi、电脑 IP 没变、Windows 防火墙放行了该端口。";
  }
  if (requestUrl && requestUrl.ok && fetchPing && !fetchPing.ok) {
    return "只能用 requestUrl：正式实现以它为主通道（它没有超时控制，需要自己兜底）。";
  }
  if (requestUrl && requestUrl.ok && bigDownload && !bigDownload.ok) {
    return "小请求能通但 8MB 分块下载失败，正式实现必须缩小分块（建议降到 1–2MB）。";
  }
  if (bigWrite && !bigWrite.ok) {
    return "网络通了但移动端写盘有问题，需要改用更小的块或换写入策略。";
  }
  return "全部通过：明文 HTTP 可用，分块传输与落盘都正常，可以进入正式实现。";
}

class ReportModal extends Modal {
  private report: string;

  constructor(app: App, report: string) {
    super(app);
    this.report = report;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("局域网自检报告");
    const pre = contentEl.createEl("pre", { cls: "lan-sync-report" });
    pre.setText(this.report);

    const buttons = contentEl.createDiv({ cls: "lan-sync-modal-buttons" });
    const copy = buttons.createEl("button", { text: "复制报告" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.report);
        new Notice("已复制到剪贴板");
      } catch {
        new Notice("复制失败，请长按文本手动复制");
      }
    });
    const close = buttons.createEl("button", { text: "关闭" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function randomPairCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
