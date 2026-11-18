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
import { buildManifest } from "./core/manifest";
import { planSync, summarizePlan, type SyncPlan, type ConflictItem, type ChangeItem } from "./core/plan";
import { emptyBaseline, type Baseline, type FileEntry } from "./core/types";
import { applyPullPlan, applyPushPlan } from "./core/engine";
import { HttpRemote } from "./net/remote";
import type { IgnoreConfig } from "./core/ignore";

export default class LanSyncPlugin extends Plugin {
  settings!: LanSyncSettings;
  server: SyncServerHandle | null = null;
  logs: string[] = [];
  settingsTab: LanSyncSettingTab | null = null;

  private selfTestRunning = false;
  private syncRunning = false;
  private applying = false;
  private lastSyncAt = 0;
  private debounceTimer: number | null = null;
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

    this.addCommand({
      id: "sync-now",
      name: "立即同步（按设置的方向）",
      callback: () => void this.runSync(),
    });

    if (Platform.isDesktopApp && this.settings.autoStartServer) {
      try {
        await this.startServer();
      } catch (err) {
        this.log(`服务启动失败：${errMsg(err)}`);
        new Notice(`局域网服务启动失败：${errMsg(err)}`);
      }
    }

    this.registerTriggers();
  }

  /** 注册自动同步触发器。改设置不需要重注册：处理器每次都读当前设置。 */
  private registerTriggers(): void {
    if (this.settings.syncOnOpen) {
      window.setTimeout(() => void this.runSync(true), 3000);
    }

    const onVaultChange = () => {
      if (!this.settings.syncEnabled || this.settings.syncDebounceSeconds <= 0) return;
      if (this.syncRunning || this.applying) return;
      if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => {
        this.debounceTimer = null;
        void this.runSync(true);
      }, this.settings.syncDebounceSeconds * 1000);
    };

    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    // 定时同步：每分钟检查一次，避免频繁重建 timer
    this.registerInterval(
      window.setInterval(() => {
        if (!this.settings.syncEnabled || this.settings.syncIntervalMinutes <= 0) return;
        if (this.syncRunning) return;
        if (Date.now() - this.lastSyncAt < this.settings.syncIntervalMinutes * 60_000) return;
        void this.runSync(true);
      }, 60_000)
    );
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

  pluginDir(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/lan-sync`);
  }

  ignoreConfig(): IgnoreConfig {
    return {
      configDir: this.app.vault.configDir,
      selfPluginId: "lan-sync",
      syncPluginData: this.settings.syncPluginData,
    };
  }

  async loadBaseline(): Promise<Baseline> {
    const adapter: any = this.app.vault.adapter;
    const path = `${this.pluginDir()}/baseline.json`;
    try {
      if (!(await adapter.exists(path))) return emptyBaseline();
      const raw = await adapter.read(path);
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.entries) return parsed as Baseline;
    } catch (err) {
      this.log(`读取基线失败，按首次同步处理：${errMsg(err)}`);
    }
    return emptyBaseline();
  }

  async saveBaseline(baseline: Baseline): Promise<void> {
    const adapter: any = this.app.vault.adapter;
    const path = `${this.pluginDir()}/baseline.json`;
    await adapter.write(path, JSON.stringify(baseline));
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
      vaultDir: basePath || undefined,
      ignore: this.ignoreConfig(),
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

  async runSync(auto = false): Promise<void> {
    if (this.syncRunning) {
      new Notice("同步正在进行，请稍候…");
      return;
    }
    let target: Target;
    try {
      target = this.resolveTarget();
    } catch (err) {
      if (auto) this.log(`自动同步跳过：${errMsg(err)}`);
      else new Notice(errMsg(err));
      return;
    }

    this.syncRunning = true;
    const notice = new Notice("正在扫描本机文件…", 0);
    let remote: HttpRemote | null = null;
    try {
      const adapter: any = this.app.vault.adapter;
      const local = await buildManifest(adapter, {
        ignore: this.ignoreConfig(),
        maxHashBytes: 24 * 1024 * 1024,
        onProgress: (info) => {
          if (info.scanned % 25 === 0) notice.setMessage(`扫描中 ${info.scanned}：${info.current}`);
        },
      });

      notice.setMessage("正在获取电脑上的文件清单…");
      const chunkBytes = Math.max(0.25, this.settings.chunkMB) * 1024 * 1024;
      const remoteClient = new HttpRemote(target.base, target.token, chunkBytes);
      remote = remoteClient;
      await remoteClient.startSession();
      const remoteManifest = await remoteClient.fetchManifest();
      const baseline = await this.loadBaseline();

      // 清理基线里已经不在任何一端的条目（例如后来加入了新的忽略规则）
      const knownPaths = new Set([
        ...local.entries.map((entry) => entry.path),
        ...remoteManifest.entries.map((entry) => entry.path),
      ]);
      for (const key of Object.keys(baseline.entries)) {
        if (!knownPaths.has(key)) delete baseline.entries[key];
      }

      const plan = planSync(local.entries, remoteManifest.entries, baseline, {
        mode: this.settings.syncMode,
        maxDeletes: this.settings.maxDeletes,
      });
      notice.hide();

      this.log(
        `同步预览（${this.settings.syncMode}）：本机 ${local.entries.length} / 电脑 ${remoteManifest.entries.length} → ${summarizePlan(plan)}`
      );

      const hasWork =
        plan.downloads.length + plan.uploads.length + plan.deleteLocal.length + plan.deleteRemote.length > 0;
      if (!hasWork) {
        if (!auto) new ReportModal(this.app, "没有需要同步的改动（两端一致）。").open();
        return;
      }

      const mustPreview = !auto || baseline.updatedAt === 0 || Boolean(plan.breaker) || plan.conflicts.length > 0;
      if (!mustPreview) {
        // 自动同步：无人值守时不弹预览，直接应用（首次同步 / 冲突 / 熔断仍然会弹）
        await this.applySync(plan, remoteClient, remoteManifest.entries, baseline);
        return;
      }

      new SyncPreviewModal(this.app, {
        plan,
        localCount: local.entries.length,
        remoteCount: remoteManifest.entries.length,
        firstSync: baseline.updatedAt === 0,
        mode: this.settings.syncMode,
        onConfirm: () => this.applySync(plan, remoteClient, remoteManifest.entries, baseline),
      }).open();
    } catch (err) {
      notice.hide();
      new ReportModal(this.app, `同步失败：${errMsg(err)}`).open();
    } finally {
      if (remote) await remote.endSession();
      this.syncRunning = false;
      this.lastSyncAt = Date.now();
    }
  }

  private async applySync(
    plan: SyncPlan,
    remote: HttpRemote,
    remoteEntries: FileEntry[],
    baseline: Baseline
  ): Promise<void> {
    const adapter: any = this.app.vault.adapter;
    const progress = new Notice("开始同步…", 0);
    this.applying = true;
    let lastTick = 0;
    const tick = (label: string) => {
      const now = Date.now();
      if (now - lastTick > 300) {
        lastTick = now;
        progress.setMessage(label);
      }
    };

    try {
      // 覆盖/删除本机文件之前先备份到 .trash（同步忽略 .trash）
      const backupTargets: string[] = [...plan.deleteLocal];
      for (const item of plan.downloads) {
        if (await adapter.exists(item.path)) backupTargets.push(item.path);
      }
      let backedUp = 0;
      if (backupTargets.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        progress.setMessage(`正在备份 ${backupTargets.length} 个将被覆盖/删除的文件…`);
        backedUp = await this.backupFiles(backupTargets, `.trash/lan-sync-backup-${stamp}`);
      }

      let current = baseline;
      let downloaded = 0;
      let downloadedBytes = 0;
      let deletedLocal = 0;
      let uploaded = 0;
      let uploadedBytes = 0;
      let deletedRemote = 0;
      const errors: Array<{ path: string; message: string }> = [];

      if (this.settings.syncMode !== "push") {
        const pull = await applyPullPlan(adapter, remote, plan, current, {
          tmpDir: this.tempDir(),
          remoteEntries,
          onProgress: (info) => tick(`拉取 ${info.done}/${info.total}：${info.label}`),
        });
        current = pull.newBaseline;
        downloaded = pull.appliedDownloads.length;
        downloadedBytes = pull.bytes;
        deletedLocal = pull.appliedDeletes.length;
        errors.push(...pull.errors);
      }

      if (this.settings.syncMode !== "pull") {
        const push = await applyPushPlan(adapter, remote, plan, current, {
          chunkBytes: Math.max(0.25, this.settings.chunkMB) * 1024 * 1024,
          remoteEntries,
          onProgress: (info) => tick(`推送 ${info.done}/${info.total}：${info.label}`),
        });
        current = push.newBaseline;
        uploaded = push.appliedDownloads.length;
        uploadedBytes = push.bytes;
        deletedRemote = push.appliedDeletes.length;
        errors.push(...push.errors);
      }

      await this.saveBaseline(current);
      progress.hide();

      const lines = [
        "LAN Sync · 同步结果",
        `拉取：${downloaded} 个（${formatBytes(downloadedBytes)}），删除本机 ${deletedLocal} 个`,
        `推送：${uploaded} 个（${formatBytes(uploadedBytes)}），删除电脑 ${deletedRemote} 个`,
        `已备份：${backedUp} 个（.trash/lan-sync-backup-*）`,
        `冲突未处理：${plan.conflicts.length} 个`,
        `跳过：${plan.skipped.length} 个`,
      ];
      if (errors.length) {
        lines.push("", `失败 ${errors.length} 个：`);
        for (const item of errors.slice(0, 20)) lines.push(`  ✗ ${item.path}：${item.message}`);
      }
      if (plan.conflicts.length) {
        lines.push("", "冲突文件（两端都改过，本次保持原样）：");
        for (const item of plan.conflicts.slice(0, 20)) lines.push(`  ⚠ ${item.path}（${item.reason}）`);
      }
      this.log(
        `同步完成：拉取 ${downloaded}，推送 ${uploaded}，错误 ${errors.length}`
      );
      if (plan.conflicts.length) {
        new ConflictModal(this.app, this, plan.conflicts, lines).open();
      } else {
        new ReportModal(this.app, lines.join("\n")).open();
      }
    } catch (err) {
      progress.hide();
      new ReportModal(this.app, `同步中断：${errMsg(err)}`).open();
    } finally {
      this.applying = false;
    }
  }

  /** 冲突的三个处理方式：留电脑 / 留手机 / 两份都留。 */
  async resolveConflict(conflict: ConflictItem, choice: "remote" | "local" | "both"): Promise<void> {
    const target = this.resolveTarget();
    const chunkBytes = Math.max(0.25, this.settings.chunkMB) * 1024 * 1024;
    const remote = new HttpRemote(target.base, target.token, chunkBytes);
    const adapter: any = this.app.vault.adapter;
    this.applying = true;
    let sessionStarted = false;
    try {
      await remote.startSession();
      sessionStarted = true;
      const baseline = await this.loadBaseline();
    const remoteItem: ChangeItem = {
      path: conflict.path,
      size: conflict.remoteSize,
      sha256: conflict.remoteSha,
      mtime: 0,
    };
    const localItem: ChangeItem = {
      path: conflict.path,
      size: conflict.localSize,
      sha256: conflict.localSha,
      mtime: 0,
    };

    if (choice === "remote") {
      const result = await applyPullPlan(adapter, remote, singlePlan({ downloads: [remoteItem] }), baseline, {
        tmpDir: this.tempDir(),
        remoteEntries: [],
      });
      if (result.errors.length) throw new Error(result.errors[0].message);
      await this.saveBaseline(result.newBaseline);
    } else if (choice === "local") {
      const result = await applyPushPlan(adapter, remote, singlePlan({ uploads: [localItem] }), baseline, {
        chunkBytes,
        remoteEntries: [],
      });
      if (result.errors.length) throw new Error(result.errors[0].message);
      await this.saveBaseline(result.newBaseline);
    } else {
      // 保留两份：先把本机版本复制成冲突副本，再用电脑版本覆盖原文件。
      const data = await adapter.readBinary(conflict.path);
      const copyPath = conflictCopyPath(conflict.path);
      await adapter.writeBinary(copyPath, data);
      const result = await applyPullPlan(adapter, remote, singlePlan({ downloads: [remoteItem] }), baseline, {
        tmpDir: this.tempDir(),
        remoteEntries: [],
      });
      if (result.errors.length) throw new Error(result.errors[0].message);
      await this.saveBaseline(result.newBaseline);
    }
    this.log(`解决冲突：${conflict.path} → ${choice}`);
    } finally {
      if (sessionStarted) await remote.endSession();
      this.applying = false;
    }
  }

  /** 覆盖/删除前把文件复制到 .trash，避免首次同步或误判造成不可逆损失。 */
  private async backupFiles(paths: string[], folder: string): Promise<number> {
    const adapter: any = this.app.vault.adapter;
    let count = 0;
    for (const path of paths) {
      try {
        if (!(await adapter.exists(path))) continue;
        const stat = await adapter.stat(path);
        if (!stat || stat.type !== "file") continue;
        if (stat.size > 24 * 1024 * 1024) {
          this.log(`跳过备份超大文件：${path}（${formatBytes(stat.size)}）`);
          continue;
        }
        const data = await adapter.readBinary(path);
        const dest = `${folder}/${path}`;
        await ensureParentDir(adapter, dest);
        await adapter.writeBinary(dest, data);
        count++;
      } catch (err) {
        this.log(`备份失败 ${path}：${errMsg(err)}`);
      }
    }
    return count;
  }

  async cleanTempFiles(): Promise<void> {    const adapter: any = this.app.vault.adapter;
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

interface SyncPreviewOptions {
  plan: SyncPlan;
  localCount: number;
  remoteCount: number;
  firstSync: boolean;
  mode: "pull" | "push" | "both";
  onConfirm: () => Promise<void>;
}

class SyncPreviewModal extends Modal {
  private busy = false;
  private options: SyncPreviewOptions;

  constructor(app: App, options: SyncPreviewOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("同步预览（尚未写入任何文件）");
    contentEl.createEl("p", {
      text: `本机 ${this.options.localCount} 个文件 · 电脑 ${this.options.remoteCount} 个文件`,
    });
    if (this.options.firstSync) {
      contentEl.createEl("p", {
        cls: "lan-sync-warn",
        text: "这是首次同步：请先看完清单再开始，建议先备份手机库。",
      });
    }

    const plan = this.options.plan;
    const modeLabel =
      this.options.mode === "pull" ? "只拉取（电脑→本机）" : this.options.mode === "push" ? "只推送（本机→电脑）" : "双向";
    const lines: string[] = [`方向：${modeLabel}`, summarizePlan(plan), ""];
    if (plan.breaker) lines.push(`⛔ ${plan.breaker.message}`, "");
    appendSection(lines, "将下载 / 覆盖本机", plan.downloads.map((d) => `${d.path}（${formatBytes(d.size)}）`));
    appendSection(lines, "将上传到电脑", plan.uploads.map((u) => `${u.path}（${formatBytes(u.size)}）`));
    appendSection(lines, "将删除本机", plan.deleteLocal);
    appendSection(lines, "将删除电脑上的文件", plan.deleteRemote);
    appendSection(lines, "冲突（本次不处理）", plan.conflicts.map((c) => `${c.path}（${c.reason}）`));
    appendSection(lines, "跳过", plan.skipped.map((s) => `${s.path}：${s.reason}`));

    const pre = contentEl.createEl("pre", { cls: "lan-sync-report" });
    pre.setText(lines.join("\n"));

    const buttons = contentEl.createDiv({ cls: "lan-sync-modal-buttons" });
    const cancel = buttons.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    const confirm = buttons.createEl("button", {
      text: plan.breaker ? "已中止" : "开始同步",
      cls: "mod-cta",
    });
    if (plan.breaker) confirm.disabled = true;
    confirm.addEventListener("click", () => {
      if (this.busy) return;
      this.busy = true;
      confirm.disabled = true;
      confirm.textContent = "同步中…";
      // 先关闭预览，再在下一拍执行；否则结果弹窗会和预览叠在一起
      this.close();
      window.setTimeout(() => {
        void this.options.onConfirm().catch((err) => {
          new Notice(`同步失败：${errMsg(err)}`, 8000);
        });
      }, 80);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function appendSection(lines: string[], title: string, items: string[]): void {
  if (!items.length) return;
  lines.push(`【${title}】共 ${items.length} 项`);
  for (const item of items.slice(0, 30)) lines.push(`  ${item}`);
  if (items.length > 30) lines.push(`  …还有 ${items.length - 30} 项`);
  lines.push("");
}

function singlePlan(parts: {
  downloads?: ChangeItem[];
  uploads?: ChangeItem[];
  deleteLocal?: string[];
  deleteRemote?: string[];
}): SyncPlan {
  return {
    downloads: parts.downloads ?? [],
    uploads: parts.uploads ?? [],
    deleteLocal: parts.deleteLocal ?? [],
    deleteRemote: parts.deleteRemote ?? [],
    conflicts: [],
    skipped: [],
    unchanged: 0,
    unchangedPaths: [],
    breaker: null,
    totals: { localFiles: 0, remoteFiles: 0 },
  };
}

function conflictCopyPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  const device = Platform.isMobileApp ? "手机" : "电脑";
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .slice(0, 15);
  return `${dir}${base}.conflict-${device}-${stamp}${ext}`;
}

class ConflictModal extends Modal {
  private plugin: LanSyncPlugin;
  private conflicts: ConflictItem[];
  private summary: string[];

  constructor(app: App, plugin: LanSyncPlugin, conflicts: ConflictItem[], summary: string[]) {
    super(app);
    this.plugin = plugin;
    this.conflicts = conflicts;
    this.summary = summary;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("冲突处理");
    contentEl.createEl("p", {
      text: `有 ${this.conflicts.length} 个文件两端都改过。逐条选择保留哪个版本：`,
    });

    const pre = contentEl.createEl("pre", { cls: "lan-sync-report" });
    pre.setText(this.summary.join("\n"));

    const options: Array<[string, "remote" | "local" | "both"]> = [
      ["留电脑版本", "remote"],
      ["留手机版本", "local"],
      ["两份都留", "both"],
    ];

    for (const conflict of this.conflicts) {
      const row = contentEl.createDiv({ cls: "lan-sync-conflict" });
      row.createEl("div", { cls: "lan-sync-conflict-path", text: conflict.path });
      const buttons = row.createDiv({ cls: "lan-sync-modal-buttons" });
      for (const [label, choice] of options) {
        const button = buttons.createEl("button", { text: label });
        button.addEventListener("click", async () => {
          buttons.querySelectorAll("button").forEach((item) => {
            (item as HTMLButtonElement).disabled = true;
          });
          const status = row.createEl("span", { cls: "lan-sync-muted", text: "处理中…" });
          try {
            await this.plugin.resolveConflict(conflict, choice);
            status.setText("✓ 已处理");
          } catch (err) {
            status.setText(`失败：${errMsg(err)}`);
            buttons.querySelectorAll("button").forEach((item) => {
              (item as HTMLButtonElement).disabled = false;
            });
          }
        });
      }
    }

    const close = contentEl.createEl("button", { text: "关闭" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
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

async function ensureParentDir(adapter: any, filePath: string): Promise<void> {
  const index = filePath.lastIndexOf("/");
  if (index <= 0) return;
  const dir = filePath.slice(0, index);
  const parts = dir.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}
