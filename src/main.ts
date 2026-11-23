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
import type { HashCacheEntry } from "./core/manifest";
import { planSync, planHasWork, requiresConfirmation, summarizePlan, type SyncPlan, type ConflictItem } from "./core/plan";
import { emptyBaseline, type Baseline, type FileEntry } from "./core/types";
import { applyPullPlan, applyPushPlan, applyConflictChoice, applyKeepBothLocalWins } from "./core/engine";
import { HttpRemote, type SyncRemote } from "./net/remote";
import { createWebDavRemote } from "./net/webdav";
import type { RemoteCacheEntry } from "./net/webdav-protocol";
import type { IgnoreConfig } from "./core/ignore";
import { isIgnored } from "./core/ignore";

export default class LanSyncPlugin extends Plugin {
  settings!: LanSyncSettings;
  server: SyncServerHandle | null = null;
  logs: string[] = [];
  settingsTab: LanSyncSettingTab | null = null;

  private selfTestRunning = false;
  private syncRunning = false;
  private applying = false;
  private lastSyncAt = 0;
  /** 所有自动触发共用的唯一定时器：合并启动/回前台/变更/定时，天然去重 */
  private autoSyncTimer: number | null = null;
  /** 同步进行中又被触发：结束后补跑一次，避免丢失真实编辑 */
  private pendingAutoSync = false;
  private syncState: "idle" | "syncing" | "ok" | "error" = "idle";
  private ribbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  /** 本地哈希缓存（mtime+size → sha256），加速扫描、支撑轻量预检 */
  private localHashCache = new Map<string, HashCacheEntry>();
  /** 远端（WebDAV）哈希缓存（ETag 令牌 → sha256） */
  private remoteHashCache = new Map<string, RemoteCacheEntry>();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadSyncCaches();
    this.settingsTab = new LanSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // 侧栏主按钮：立即同步（手机端在左侧抽屉里）
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "局域网同步：立即同步", () => {
      void this.runSync();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("lan-sync-status");
    this.statusBarEl.addEventListener("click", () => void this.runSync());
    this.updateStatusBar();

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
      icon: "refresh-cw",
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

  /** 注册自动同步触发器。所有触发都汇入同一个定时器：启动与回前台不再各跑一次，真实编辑也不会被丢掉。 */
  private registerTriggers(): void {
    if (this.settings.syncOnOpen) {
      this.scheduleAutoSync(3000);
    }

    // 回到前台：和启动触发共用同一个定时器，谁后到谁覆盖，最终只跑一次
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - this.lastSyncAt < 60_000) return;
      this.scheduleAutoSync(500);
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.register(() => document.removeEventListener("visibilitychange", onVisibility));

    // 文件变更：防抖后排队；若正在同步，只标记待跑，结束后补一次（不丢编辑）
    const onVaultChange = (file?: { path?: string }) => {
      if (!this.settings.syncEnabled || this.settings.syncDebounceSeconds <= 0) return;
      // 忽略插件自身目录（基线文件每次同步都会写）、.trash、.git 等，
      // 否则「写基线」会再次触发同步，形成自我循环。
      const changedPath = file && typeof file.path === "string" ? file.path : "";
      if (changedPath && isIgnored(changedPath, this.ignoreConfig())) return;
      if (this.syncRunning || this.applying) {
        this.pendingAutoSync = true;
        return;
      }
      this.scheduleAutoSync(this.settings.syncDebounceSeconds * 1000);
    };
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));

    // 定时同步：每分钟检查一次，到了间隔才排队
    this.registerInterval(
      window.setInterval(() => {
        if (!this.settings.syncEnabled || this.settings.syncIntervalMinutes <= 0) return;
        if (Date.now() - this.lastSyncAt < this.settings.syncIntervalMinutes * 60_000) return;
        this.scheduleAutoSync(0);
      }, 60_000)
    );
  }

  /** 自动同步唯一入口：多次触发只保留最后一次；正在同步时标记待跑而不是丢弃。 */
  private scheduleAutoSync(delayMs: number): void {
    if (!this.settings.syncEnabled) return;
    if (this.syncRunning || this.applying) {
      this.pendingAutoSync = true;
      return;
    }
    if (this.autoSyncTimer) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.runSync(true);
    }, delayMs);
  }

  async onunload(): Promise<void> {
    if (this.autoSyncTimer) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
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
    if (!this.settings.deviceId) {
      this.settings.deviceId = randomDeviceId();
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
      syncSelfCode: this.settings.syncSelfCode,
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

  private maxHashBytes(): number {
    return 24 * 1024 * 1024;
  }

  private chunkBytes(): number {
    return Math.max(0.25, this.settings.chunkMB) * 1024 * 1024;
  }

  private deviceName(): string {
    return Platform.isMobileApp ? "手机" : "电脑";
  }

  private isWebDavConfigured(): boolean {
    if (!this.settings.webdavEnabled) return false;
    // WebDAV 服务器通常是与 Obsidian 客户端分开的一台常开设备（如“旧手机”），
    // 主用手机和电脑两个客户端都要填它的 IP；若 rclone 恰好与本机同机，才显式填 127.0.0.1。
    return Boolean(this.settings.webdavHost.trim());
  }

  private webdavBase(): string {
    const raw = this.settings.webdavHost.trim();
    const clean = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const proto = this.settings.webdavHttps ? "https" : "http";
    return `${proto}://${clean}:${this.settings.webdavPort}`;
  }

  /** 当前库文件夹名（固定，不可改）：用作 WebDAV 同步根的最后一段。 */
  webdavVaultName(): string {
    const name = String(this.app.vault.getName?.() || "vault").trim();
    return name || "vault";
  }

  /**
   * WebDAV 同步根 = `<路径前缀>/<库名>`。
   * 前缀可自定义命名/层级、可留空；库名固定为当前库文件夹名（如 Obsidian-Vault），不可改。
   */
  webdavRoot(): string {
    const prefix = String(this.settings.webdavPathPrefix || "")
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s && s !== "." && s !== "..")
      .join("/");
    const vault = this.webdavVaultName();
    return prefix ? `${prefix}/${vault}` : vault;
  }

  private webdavConfig() {
    return {
      baseUrl: this.webdavBase(),
      root: this.webdavRoot(),
      user: this.settings.webdavUser,
      pass: this.settings.webdavPassword,
      deviceId: this.settings.deviceId,
      deviceName: this.deviceName(),
      ignore: this.ignoreConfig(),
      chunkBytes: this.chunkBytes(),
      maxHashBytes: this.maxHashBytes(),
      timeoutMs: 30000,
    };
  }

  /** 选择传输：WebDAV 优先；手机端连不上时退回直连电脑 HTTP 服务。 */
  private async openRemote(): Promise<{ remote: SyncRemote; label: string }> {
    const wantWebdav = this.settings.transport !== "server";
    if (wantWebdav && this.isWebDavConfigured()) {
      try {
        const wd = createWebDavRemote(this.webdavConfig(), this.remoteHashCache);
        await (wd as any).probe?.();
        return { remote: wd, label: "WebDAV" };
      } catch (err) {
        this.log(`WebDAV 不可用：${errMsg(err)}`);
        if (this.settings.transport === "webdav") throw new Error(`WebDAV 不可用：${errMsg(err)}`);
        if (Platform.isMobileApp && this.settings.clientHost.trim()) {
          const target = this.resolveTarget();
          this.log(`改用电脑直连兜底：${target.base}`);
          return { remote: new HttpRemote(target.base, target.token, this.chunkBytes()), label: "电脑直连(兜底)" };
        }
        throw new Error(`WebDAV 不可用，且没有可用的电脑兜底：${errMsg(err)}`);
      }
    }
    const target = this.resolveTarget();
    return { remote: new HttpRemote(target.base, target.token, this.chunkBytes()), label: "电脑直连" };
  }

  async loadSyncCaches(): Promise<void> {
    const adapter: any = this.app.vault.adapter;
    const path = `${this.pluginDir()}/sync-cache.json`;
    try {
      if (!(await adapter.exists(path))) return;
      const raw = JSON.parse(await adapter.read(path));
      for (const [k, v] of Object.entries(raw?.local || {})) this.localHashCache.set(k, v as HashCacheEntry);
      for (const [k, v] of Object.entries(raw?.remote || {})) this.remoteHashCache.set(k, v as RemoteCacheEntry);
    } catch (err) {
      this.log(`读取同步缓存失败，忽略：${errMsg(err)}`);
    }
  }

  async saveSyncCaches(): Promise<void> {
    const adapter: any = this.app.vault.adapter;
    const path = `${this.pluginDir()}/sync-cache.json`;
    try {
      await adapter.write(
        path,
        JSON.stringify({
          local: Object.fromEntries(this.localHashCache),
          remote: Object.fromEntries(this.remoteHashCache),
        })
      );
    } catch (err) {
      this.log(`写入同步缓存失败：${errMsg(err)}`);
    }
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
      this.notifyError("自检失败", err);
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
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    // 完整报告写进运行日志（设置页可看），只在右上角给简短结论
    this.log(`自检完成：${passed} 项通过 / ${failed} 项失败`);
    for (const line of report.split("\n").filter(Boolean)) this.log(line);
    new Notice(
      failed === 0
        ? `✓ 自检全部通过（${passed} 项），可以开始同步`
        : `自检完成：${passed} 项通过，${failed} 项失败。详情见设置页运行日志`,
      failed === 0 ? 6000 : 12000
    );
  }

  /** 侧栏/状态栏状态：空闲、同步中、失败。手机端没有状态栏，靠 ribbon 提示。 */
  updateStatusBar(state: "idle" | "syncing" | "ok" | "error" = "idle", detail = ""): void {
    this.syncState = state;
    let label: string;
    if (state === "syncing") label = "同步中…";
    else if (state === "error") label = `同步失败${detail ? `：${detail}` : ""}`;
    else if (state === "ok") label = "已同步";
    else if (this.lastSyncAt) label = `上次同步 ${new Date(this.lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
    else label = "尚未同步";

    if (this.statusBarEl) {
      this.statusBarEl.setText(`⇅ ${label}`);
      this.statusBarEl.toggleClass("lan-sync-status--error", state === "error");
      this.statusBarEl.toggleClass("lan-sync-status--busy", state === "syncing");
    }
    if (this.ribbonEl) {
      this.ribbonEl.setAttribute("aria-label", `局域网同步：${label}（点击立即同步）`);
      this.ribbonEl.toggleClass("lan-sync-ribbon--busy", state === "syncing");
      this.ribbonEl.toggleClass("lan-sync-ribbon--error", state === "error");
    }
  }

  async runSync(auto = false): Promise<void> {
    // 自动同步有多个触发源（打开 app / 回到前台 / 文件变更 / 定时），
    // 同一时刻只跑一个同步；自动触发被撞上就记为待跑，结束后补一次（真实编辑不丢）
    if (this.syncRunning) {
      if (auto) {
        this.pendingAutoSync = true;
        return;
      }
      new Notice("同步正在进行，请稍候…");
      return;
    }
    this.syncRunning = true;
    this.updateStatusBar("syncing");
    const notice = new Notice("正在连接…", 0);
    let remote: SyncRemote | null = null;
    try {
      const opened = await this.openRemote();
      remote = opened.remote;
      await remote.startSession();

      notice.setMessage("正在扫描本机文件…");
      const adapter: any = this.app.vault.adapter;
      const local = await buildManifest(adapter, {
        ignore: this.ignoreConfig(),
        maxHashBytes: this.maxHashBytes(),
        cache: this.localHashCache,
        onProgress: (info) => {
          if (info.scanned % 25 === 0) notice.setMessage(`扫描中 ${info.scanned}：${info.current}`);
        },
      });
      // 清理本地缓存里已不存在的条目
      const localPaths = new Set(local.entries.map((entry) => entry.path));
      for (const p of Array.from(this.localHashCache.keys())) {
        if (!localPaths.has(p)) this.localHashCache.delete(p);
      }

      notice.setMessage(`正在获取远端（${opened.label}）文件清单…`);
      const remoteManifest = await remote.fetchManifest();
      const baseline = await this.loadBaseline();

      // 清理基线里已经不在任何一端的条目（例如后来加入了新的忽略规则）
      const knownPaths = new Set([...localPaths, ...remoteManifest.entries.map((entry) => entry.path)]);
      for (const key of Object.keys(baseline.entries)) {
        if (!knownPaths.has(key)) delete baseline.entries[key];
      }

      const plan = planSync(local.entries, remoteManifest.entries, baseline, {
        mode: this.settings.syncMode,
        maxDeletes: this.settings.maxDeletes,
        noBaseStrategy: this.settings.firstSyncStrategy,
      });
      notice.hide();

      this.log(
        `同步预览（${opened.label}/${this.settings.syncMode}）：本机 ${local.entries.length} / 远端 ${remoteManifest.entries.length} → ${summarizePlan(plan)}`
      );

      const hasWork = planHasWork(plan);
      const unsafePaths = plan.skipped
        .filter((item) => item.reason.includes("冲突标记"))
        .map((item) => item.path);
      if (!hasWork) {
        await this.saveSyncCaches();
        this.updateStatusBar("ok");
        if (unsafePaths.length) {
          new Notice(
            `⚠ 发现 ${unsafePaths.length} 个文件含未解决的冲突标记，已跳过。请先手动处理：${unsafePaths
              .slice(0, 3)
              .join("、")}${unsafePaths.length > 3 ? " 等" : ""}`,
            15000
          );
        } else {
          new Notice("两端一致，没有需要同步的改动。", 4000);
        }
        return;
      }

      // 首次同步 / 触发删除熔断必须确认；冲突在开启「自动留两份」时不再打断
      let confirm = requiresConfirmation(plan, baseline);
      if (confirm.required && plan.conflicts.length > 0 && this.settings.autoConflictResolve) {
        const stillRequired = Boolean(plan.breaker) || baseline.updatedAt === 0;
        if (!stillRequired) confirm = { required: false, reason: null };
      }
      if (auto && confirm.required) {
        new Notice(`⏸ 已暂停自动同步：${confirm.reason}。请点侧栏 ⇅ 按钮预览并确认后执行。`, 12000);
        this.updateStatusBar("idle");
        return;
      }

      if (auto) {
        const outcome = await this.applySync(plan, remote, remoteManifest.entries, baseline);
        await this.finishConflicts(outcome, remote);
        await this.saveSyncCaches();
        this.presentOutcome(outcome, true);
        return;
      }

      new SyncPreviewModal(this.app, {
        plan,
        localCount: local.entries.length,
        remoteCount: remoteManifest.entries.length,
        firstSync: baseline.updatedAt === 0,
        mode: this.settings.syncMode,
        onConfirm: async () => {
          const outcome = await this.applySync(plan, remote!, remoteManifest.entries, baseline);
          await this.finishConflicts(outcome, remote!);
          await this.saveSyncCaches();
          this.presentOutcome(outcome, false);
        },
      }).open();
    } catch (err) {
      notice.hide();
      this.updateStatusBar("error", errMsg(err));
      this.notifyError("同步失败", err);
    } finally {
      if (remote) await remote.endSession();
      this.syncRunning = false;
      this.lastSyncAt = Date.now();
      // 如果还没进入写入阶段（比如只是预览），把状态回落；错误状态保留
      if (this.syncState === "syncing") this.updateStatusBar("idle");
      // 同步期间又有真实变更：补跑一次
      if (this.pendingAutoSync) {
        this.pendingAutoSync = false;
        this.scheduleAutoSync(0);
      }
    }
  }

  /** 自动处理冲突（默认「留两份、本机优先」）；关闭时留给 ConflictModal 人工复核。 */
  private async finishConflicts(outcome: SyncOutcome, remote: SyncRemote): Promise<void> {
    if (!outcome.conflictItems.length) return;
    if (!this.settings.autoConflictResolve) return; // 交给弹窗
    const r = await this.resolveConflictsAuto(outcome.conflictItems, remote);
    outcome.resolvedConflicts = r.resolved;
    if (r.errors.length) {
      outcome.conflictErrors = r.errors;
      for (const e of r.errors) outcome.lines.push(`  ✗ 冲突自动处理失败：${e}`);
    }
    if (r.resolved) outcome.lines.push("", `已自动保留两份（本机版留原名）：${r.resolved} 个`);
    this.log(`自动处理冲突：成功 ${r.resolved}，失败 ${r.errors.length}`);
    outcome.conflictItems = [];
  }

  private async resolveConflictsAuto(
    conflicts: ConflictItem[],
    remote: SyncRemote
  ): Promise<{ resolved: number; errors: string[] }> {
    const adapter: any = this.app.vault.adapter;
    let baseline = await this.loadBaseline();
    const errors: string[] = [];
    let resolved = 0;
    for (const conflict of conflicts) {
      try {
        const res = await applyKeepBothLocalWins(adapter, remote, remote, conflict, baseline, {
          chunkBytes: this.chunkBytes(),
          tmpDir: this.tempDir(),
          makeCopyPath: conflictCopyPath,
        });
        if (res.errors.length) {
          errors.push(`${conflict.path}：${res.errors.join("；")}`);
        } else {
          baseline = res.newBaseline;
          resolved++;
        }
      } catch (err) {
        errors.push(`${conflict.path}：${errMsg(err)}`);
      }
    }
    await this.saveBaseline(baseline);
    return { resolved, errors };
  }

  /** 执行同步计划并返回结构化结果；不做任何提示，展示交给 presentOutcome。 */
  private async applySync(
    plan: SyncPlan,
    remote: SyncRemote,
    remoteEntries: FileEntry[],
    baseline: Baseline
  ): Promise<SyncOutcome> {
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
      const remotePathSet = new Set(remoteEntries.map((entry) => entry.path));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const backupFolder = `.trash/lan-sync-backup-${stamp}`;

      // 覆盖/删除本机文件之前先备份（.trash 本身被同步忽略）
      const localBackupTargets: string[] = [...plan.deleteLocal];
      for (const item of plan.downloads) {
        if (await adapter.exists(item.path)) localBackupTargets.push(item.path);
      }
      // 覆盖/删除电脑端文件之前也要备份，否则「已备份」只保住了本机这一半
      const remoteBackupTargets: string[] = [
        ...plan.deleteRemote,
        ...plan.uploads.filter((item) => remotePathSet.has(item.path)).map((item) => item.path),
      ];

      let backedUp = 0;
      if (localBackupTargets.length) {
        progress.setMessage(`正在备份本机 ${localBackupTargets.length} 个将被覆盖/删除的文件…`);
        backedUp += await this.backupFiles(localBackupTargets, backupFolder);
      }
      if (remoteBackupTargets.length) {
        progress.setMessage(`正在备份电脑端 ${remoteBackupTargets.length} 个将被覆盖/删除的文件…`);
        try {
          backedUp += await remote.backupFiles(remoteBackupTargets, backupFolder);
        } catch (err) {
          // 电脑端备份失败就不冒险继续覆盖，直接中止本次同步
          throw new Error(`电脑端备份失败，已中止同步：${errMsg(err)}`);
        }
      }

      let current = baseline;
      let downloaded = 0;
      let downloadedBytes = 0;
      let deletedLocal = 0;
      let uploaded = 0;
      let uploadedBytes = 0;
      let deletedRemote = 0;
      let downloadedItems: Array<{ path: string }> = [];
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
        downloadedItems = pull.appliedDownloads;
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

      const selfDir = `${this.pluginDir()}/`;
      const selfUpdated =
        this.settings.syncSelfCode &&
        downloadedItems.some((item) => item.path.startsWith(selfDir));

      const lines = [
        "LAN Sync · 同步结果",
        `拉取：${downloaded} 个（${formatBytes(downloadedBytes)}），删除本机 ${deletedLocal} 个`,
        `推送：${uploaded} 个（${formatBytes(uploadedBytes)}），删除电脑 ${deletedRemote} 个`,
        `已备份：${backedUp} 个（${backupFolder}）`,
        `冲突未处理：${plan.conflicts.length} 个`,
        `跳过：${plan.skipped.length} 个`,
      ];
      if (plan.breaker) lines.push("", `⛔ ${plan.breaker.message}`);
      if (errors.length) {
        lines.push("", `失败 ${errors.length} 个：`);
        for (const item of errors.slice(0, 20)) lines.push(`  ✗ ${item.path}：${item.message}`);
      }
      if (plan.conflicts.length) {
        lines.push("", "冲突文件（两端都改过）：");
        for (const item of plan.conflicts.slice(0, 20)) lines.push(`  ⚠ ${item.path}（${item.reason}）`);
      }
      if (selfUpdated) {
        lines.push("", "⚠ 本插件的程序文件已更新，需要重启 Obsidian 才会生效。");
      }

      return {
        downloaded,
        downloadedBytes,
        deletedLocal,
        uploaded,
        uploadedBytes,
        deletedRemote,
        backedUp,
        errors,
        conflictItems: plan.conflicts,
        skipped: plan.skipped.length,
        unsafeSkipped: plan.skipped
          .filter((item) => item.reason.includes("冲突标记"))
          .map((item) => item.path),
        selfUpdated,
        breaker: plan.breaker ? plan.breaker.message : null,
        lines,
      };
    } catch (err) {
      progress.hide();
      throw err;
    } finally {
      this.applying = false;
    }
  }

  /** 统一展示入口：一次同步只产生一条最终提示；熔断明确说明已中止；冲突必须交互三选一。 */
  private presentOutcome(outcome: SyncOutcome, auto: boolean): void {
    for (const line of outcome.lines) this.log(line);
    this.updateStatusBar(
      outcome.errors.length || outcome.breaker ? "error" : "ok",
      outcome.errors.length ? `${outcome.errors.length} 个文件失败` : ""
    );

    if (outcome.breaker) {
      new Notice(`⛔ 同步已中止（删除保护）：${outcome.breaker}`, 15000);
      return;
    }

    // 冲突不能静默：即使自动同步也必须由用户决定保留哪一份
    if (outcome.conflictItems.length > 0) {
      new ConflictModal(this.app, this, outcome.conflictItems, outcome.lines).open();
      return;
    }

    const parts: string[] = [];
    if (outcome.downloaded) parts.push(`拉取 ${outcome.downloaded}`);
    if (outcome.uploaded) parts.push(`推送 ${outcome.uploaded}`);
    if (outcome.deletedLocal) parts.push(`删除本机 ${outcome.deletedLocal}`);
    if (outcome.deletedRemote) parts.push(`删除电脑 ${outcome.deletedRemote}`);
    const detail = parts.length ? parts.join(" · ") : "无改动";

    let text: string;
    if (outcome.errors.length) {
      text = `⇅ 同步完成，但有 ${outcome.errors.length} 个文件失败：${detail}（详见运行日志）`;
    } else {
      text = `⇅ ${auto ? "后台同步" : "同步完成"}：${detail}`;
    }
    if (outcome.unsafeSkipped.length) {
      text += `；${outcome.unsafeSkipped.length} 个文件含冲突标记已跳过，需先手动解决（${outcome.unsafeSkipped
        .slice(0, 3)
        .join("、")}${outcome.unsafeSkipped.length > 3 ? " 等" : ""}）`;
    }
    if (outcome.selfUpdated) text += "；插件文件已更新，需重启 Obsidian";
    if (outcome.resolvedConflicts) text += `；已自动保留两份 ${outcome.resolvedConflicts} 个`;
    if (outcome.conflictErrors?.length) text += `；${outcome.conflictErrors.length} 个冲突自动处理失败（见日志）`;

    new Notice(text, outcome.errors.length || outcome.unsafeSkipped.length || outcome.conflictErrors?.length ? 12000 : 6000);
  }

  /** 错误提示统一入口：三处调用格式一致，且一定写入运行日志。 */
  private notifyError(prefix: string, err: unknown): void {
    const message = `${prefix}：${errMsg(err)}`;
    this.log(message);
    new Notice(message, 10000);
  }

  /** 冲突的三个处理方式：留电脑 / 留手机 / 两份都留。 */
  async resolveConflict(conflict: ConflictItem, choice: "remote" | "local" | "both"): Promise<void> {
    const adapter: any = this.app.vault.adapter;
    this.applying = true;
    let remote: SyncRemote | null = null;
    let sessionStarted = false;
    try {
      const opened = await this.openRemote();
      remote = opened.remote;
      await remote.startSession();
      sessionStarted = true;
      const baseline = await this.loadBaseline();
      const result = await applyConflictChoice(adapter, remote, remote, conflict, choice, baseline, {
        chunkBytes: this.chunkBytes(),
        tmpDir: this.tempDir(),
        makeCopyPath: conflictCopyPath,
      });
      if (result.errors.length) throw new Error(result.errors.join("；"));
      await this.saveBaseline(result.newBaseline);
      await this.saveSyncCaches();
      this.log(
        `解决冲突：${conflict.path} → ${choice}${result.copyPath ? `（副本 ${result.copyPath}）` : ""}`
      );
    } finally {
      if (sessionStarted && remote) await remote.endSession();
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

interface SyncOutcome {
  downloaded: number;
  downloadedBytes: number;
  deletedLocal: number;
  uploaded: number;
  uploadedBytes: number;
  deletedRemote: number;
  backedUp: number;
  errors: Array<{ path: string; message: string }>;
  conflictItems: ConflictItem[];
  skipped: number;
  unsafeSkipped: string[];
  selfUpdated: boolean;
  breaker: string | null;
  lines: string[];
  resolvedConflicts?: number;
  conflictErrors?: string[];
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
    appendSection(lines, "冲突（自动留两份 / 复核）", plan.conflicts.map((c) => `${c.path}（${c.reason}）`));
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

function randomPairCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomDeviceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
