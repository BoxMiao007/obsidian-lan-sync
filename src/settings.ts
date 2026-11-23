import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type LanSyncPlugin from "./main";
import { errMsg, pingWithFetch, pingWithRequestUrl } from "./client";

export interface LanSyncSettings {
  /** 电脑端监听端口 */
  port: number;
  /** 电脑端配对码（同时作为请求令牌） */
  token: string;
  /** Obsidian 启动时自动开服务 */
  autoStartServer: boolean;
  /** 手机端填写的电脑地址（不含端口） */
  clientHost: string;
  /** 手机端填写的端口 */
  clientPort: number;
  /** 手机端填写的配对码 */
  clientToken: string;
  /** 分块大小（MB），手机端 OOM 时调小 */
  chunkMB: number;
  /** 单次同步允许的最大删除数 */
  maxDeletes: number;
  /** 同步方向 */
  syncMode: "pull" | "push" | "both";
  /** 自动同步总开关 */
  syncEnabled: boolean;
  /** 打开 app 时自动同步 */
  syncOnOpen: boolean;
  /** 文件变更后延迟多少秒自动同步，0 = 关闭 */
  syncDebounceSeconds: number;
  /** 定时同步间隔（分钟），0 = 关闭 */
  syncIntervalMinutes: number;
  /** 是否同步第三方插件的 data.json（含凭据，默认关闭） */
  syncPluginData: boolean;
  /** 首次同步时两边都有但内容不同怎么办 */
  firstSyncStrategy: "conflict" | "prefer-remote" | "prefer-local";
  /** 是否同步本插件的程序文件，让两端插件版本自动一致 */
  syncSelfCode: boolean;
  /** 传输方式：auto=WebDAV 优先、手机端兜底电脑；webdav=只用 WebDAV；server=只用电脑直连 */
  transport: "auto" | "webdav" | "server";
  /** 是否启用 WebDAV 中转 */
  webdavEnabled: boolean;
  /** WebDAV 主机：手机留空（127.0.0.1），电脑填手机 IP */
  webdavHost: string;
  webdavPort: number;
  webdavHttps: boolean;
  webdavUser: string;
  webdavPassword: string;
  /** WebDAV 下同步根的「路径前缀」：可自定义命名/层级，留空=直接用库名；库名固定不可改 */
  webdavPathPrefix: string;
  /** 冲突自动「留两份、本机优先」；关闭则弹三选一复核 */
  autoConflictResolve: boolean;
  /** 设备唯一标识（锁文件里区分谁在同步） */
  deviceId: string;
}

export const DEFAULT_SETTINGS: LanSyncSettings = {
  port: 28900,
  token: "",
  autoStartServer: true,
  clientHost: "",
  clientPort: 28900,
  clientToken: "",
  chunkMB: 4,
  maxDeletes: 20,
  syncMode: "pull",
  syncEnabled: true,
  syncOnOpen: true,
  syncDebounceSeconds: 10,
  syncIntervalMinutes: 0,
  syncPluginData: false,
  firstSyncStrategy: "conflict",
  syncSelfCode: true,
  transport: "auto",
  webdavEnabled: true,
  webdavHost: "",
  webdavPort: 8080,
  webdavHttps: false,
  webdavUser: "webdav",
  webdavPassword: "",
  webdavPathPrefix: "",
  autoConflictResolve: true,
  deviceId: "",
};

type ButtonDef = { text: string; cta?: boolean; onClick: () => void | Promise<void> };

/**
 * 设置页。用一组小的构建器（toggle/text/number/dropdown/buttons）收敛样板，
 * 再按语义拆成独立卡片；所有设置项与持久化行为保持不变。
 */
export class LanSyncSettingTab extends PluginSettingTab {
  plugin: LanSyncPlugin;
  private logEl: HTMLElement | null = null;

  constructor(app: App, plugin: LanSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("lan-sync-settings");
    containerEl.createEl("h2", { text: "局域网同步" });

    this.renderWebDavSection(containerEl);
    this.renderSyncSection(containerEl);
    this.renderAutoSyncSection(containerEl);
    this.renderServerSection(containerEl);
    this.renderSelfTestSection(containerEl);
    this.renderLogSection(containerEl);
  }

  // ---------- 卡片与构件的公共封装 ----------

  private card(parent: HTMLElement, title: string, intro?: string): HTMLElement {
    const card = parent.createDiv({ cls: "lan-sync-card" });
    card.createEl("h3", { text: title });
    if (intro) card.createEl("p", { cls: "lan-sync-muted", text: intro });
    return card;
  }

  private base(parent: HTMLElement, name: string, desc?: string): Setting {
    const st = new Setting(parent).setName(name);
    if (desc) st.setDesc(desc);
    return st;
  }

  private async commit(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private toggle(parent: HTMLElement, name: string, value: boolean, onSet: (v: boolean) => void, desc?: string): void {
    this.base(parent, name, desc).addToggle((t) =>
      t.setValue(value).onChange(async (v) => {
        onSet(v);
        await this.commit();
      })
    );
  }

  private text(
    parent: HTMLElement,
    name: string,
    value: string,
    onInput: (v: string) => void,
    opts: { desc?: string; placeholder?: string; password?: boolean } = {}
  ): void {
    this.base(parent, name, opts.desc).addText((t) => {
      if (opts.password) t.inputEl.type = "password";
      t.setPlaceholder(opts.placeholder ?? "")
        .setValue(value)
        .onChange(async (v) => {
          onInput(v);
          await this.commit();
        });
    });
  }

  private number(
    parent: HTMLElement,
    name: string,
    value: number,
    onValid: (v: number) => void,
    opts: { desc?: string; placeholder?: string; min: number; max: number; integer?: boolean }
  ): void {
    const integer = opts.integer !== false;
    this.base(parent, name, opts.desc).addText((t) =>
      t.setPlaceholder(opts.placeholder ?? String(value))
        .setValue(String(value))
        .onChange(async (v) => {
          const n = integer ? parseInt(v, 10) : parseFloat(v);
          if (Number.isFinite(n) && n >= opts.min && n <= opts.max) {
            onValid(n);
            await this.commit();
          }
        })
    );
  }

  private dropdown(
    parent: HTMLElement,
    name: string,
    value: string,
    options: Record<string, string>,
    onSet: (v: string) => void,
    desc?: string
  ): void {
    this.base(parent, name, desc).addDropdown((d) =>
      d.addOptions(options).setValue(value).onChange(async (v) => {
        onSet(v);
        await this.commit();
      })
    );
  }

  private buttons(parent: HTMLElement, name: string, defs: ButtonDef[], desc?: string): void {
    const st = this.base(parent, name, desc);
    for (const b of defs) {
      st.addButton((btn) => {
        btn.setButtonText(b.text);
        if (b.cta) btn.setCta();
        btn.onClick(async () => {
          await b.onClick();
        });
      });
    }
  }

  // ---------- WebDAV 中转 ----------

  private renderWebDavSection(parent: HTMLElement): void {
    const s = this.plugin.settings;
    const card = this.card(parent, "WebDAV 中转（推荐）", "主用手机与电脑都连这台 WebDAV；手机连不上时兜底直连电脑。");

    this.toggle(card, "启用 WebDAV 中转", s.webdavEnabled, (v) => (s.webdavEnabled = v), "关闭后只能用电脑端 HTTP 服务（旧模式）。");

    this.dropdown(
      card,
      "传输方式",
      s.transport,
      { auto: "自动（推荐）", webdav: "只用 WebDAV", server: "只用电脑直连" },
      (v) => (s.transport = v as LanSyncSettings["transport"]),
      "自动 = WebDAV 优先、手机端兜底直连电脑。"
    );

    this.text(card, "WebDAV 服务器 IP / 主机", s.webdavHost, (v) => (s.webdavHost = v.trim()), {
      desc: "运行 rclone WebDAV 的设备 IP / 主机名，不要 http:// 与端口。",
      placeholder: "192.168.1.5",
    });

    this.number(card, "端口", s.webdavPort, (v) => (s.webdavPort = v), { desc: "默认 8080。", min: 1, max: 65535 });

    this.toggle(card, "使用 HTTPS", s.webdavHttps, (v) => (s.webdavHttps = v), "rclone 默认明文 HTTP（仅限可信 LAN）；加 TLS 才打开。");

    this.text(card, "用户名", s.webdavUser, (v) => (s.webdavUser = v.trim()), { placeholder: "webdav" });

    this.text(card, "密码", s.webdavPassword, (v) => (s.webdavPassword = v), { desc: "存本机 data.<设备>.json（不参与同步）。", placeholder: "device 私有", password: true });

    const rootPreview = card.createEl("div", { cls: "lan-sync-url", text: `当前同步根：${this.plugin.webdavRoot()}` });
    this.text(card, "路径前缀（可选）", s.webdavPathPrefix, (v) => {
      s.webdavPathPrefix = v;
      rootPreview.setText(`当前同步根：${this.plugin.webdavRoot()}`);
    }, {
      desc: "自定义命名/层级（如 aaa/play）；留空直接用库名，库名固定不可改。",
      placeholder: "留空 = 直接用库名",
    });
  }

  // ---------- 同步行为 ----------

  private renderSyncSection(parent: HTMLElement): void {
    const s = this.plugin.settings;
    const card = this.card(parent, "同步行为");

    this.dropdown(
      card,
      "同步方向",
      s.syncMode,
      { pull: "只拉取（电脑 → 本机）", push: "只推送（本机 → 电脑）", both: "双向" },
      (v) => (s.syncMode = v as LanSyncSettings["syncMode"]),
      "pull=只拉取；push=只推送；both=双向（推荐）。"
    );

    this.buttons(card, "立即同步", [{ text: "立即同步", cta: true, onClick: () => this.plugin.runSync() }], "先预览差异，确认后写入。");

    this.toggle(card, "冲突自动留两份（本机优先）", s.autoConflictResolve, (v) => (s.autoConflictResolve = v), "两端都改时自动留两份（本机留原名）；关闭则弹窗逐条复核。");

    this.dropdown(
      card,
      "首次同步冲突处理",
      s.firstSyncStrategy,
      { conflict: "逐条询问（最安全）", "prefer-remote": "以电脑为准（覆盖本机同名文件）", "prefer-local": "以本机为准（覆盖电脑同名文件）" },
      (v) => (s.firstSyncStrategy = v as LanSyncSettings["firstSyncStrategy"]),
      "本机已有旧副本、同名不同内容时怎么办。"
    );

    this.number(card, "分块大小（MB）", s.chunkMB, (v) => (s.chunkMB = v), {
      desc: "默认 4MB；8MB 自检失败就调到 1–2MB。",
      min: 0.25,
      max: 16,
      integer: false,
    });

    this.number(card, "删除保护阈值", s.maxDeletes, (v) => (s.maxDeletes = v), {
      desc: "一次删除超过该数就中止，防误删。",
      min: 1,
      max: 1000,
    });

    this.toggle(
      card,
      "同步本插件程序文件",
      s.syncSelfCode,
      (v) => (s.syncSelfCode = v),
      "把 main.js / manifest.json / styles.css 一起同步（拉取后需重启）。data.<设备>.json、基线、缓存、临时文件永不同步。"
    );

    this.toggle(
      card,
      "同步第三方插件设置（危险）",
      s.syncPluginData,
      (v) => (s.syncPluginData = v),
      "会同步各插件 data.json，可能含密码/令牌，局域网明文有泄露风险。"
    );
  }

  // ---------- 自动同步 ----------

  private renderAutoSyncSection(parent: HTMLElement): void {
    const s = this.plugin.settings;
    const card = this.card(parent, "自动同步");

    this.toggle(card, "自动同步总开关", s.syncEnabled, (v) => (s.syncEnabled = v), "关闭后只能手动同步。");
    this.toggle(card, "打开 app 时自动同步", s.syncOnOpen, (v) => (s.syncOnOpen = v), "打开 Obsidian 后自动拉一次（首次仍会确认）。");

    this.number(card, "文件变更后自动同步（秒）", s.syncDebounceSeconds, (v) => (s.syncDebounceSeconds = v), {
      desc: "停止编辑多少秒后自动同步；0=关闭。手机仅前台有效。",
      min: 0,
      max: 600,
    });

    this.number(card, "定时同步（分钟）", s.syncIntervalMinutes, (v) => (s.syncIntervalMinutes = v), {
      desc: "每多少分钟同步一次；0=关闭。",
      min: 0,
      max: 1440,
    });
  }

  // ---------- 电脑端 · 服务端 ----------

  private renderServerSection(parent: HTMLElement): void {
    const card = this.card(parent, "电脑端 · 服务端");

    if (!Platform.isDesktopApp) {
      card.createEl("p", { cls: "lan-sync-muted", text: "手机端无 Node，不能监听端口；服务端只在电脑运行。" });
      return;
    }

    const s = this.plugin.settings;
    const running = Boolean(this.plugin.server);
    card.createEl("p", { cls: running ? "lan-sync-ok" : "lan-sync-warn", text: running ? `运行中 · 端口 ${this.plugin.server?.port}` : "未启动（点下方按钮启动）" });

    if (running && this.plugin.server) {
      for (const addr of this.plugin.server.addresses) {
        card.createEl("div", { cls: "lan-sync-url", text: `${addr.url}    （${addr.name}）` });
      }
      const lanUrl = this.plugin.server.addresses[0]?.url || this.plugin.server.urls[0];
      card.createEl("div", { cls: "lan-sync-url", text: `${lanUrl}/?token=${s.token}` });
      card.createEl("p", { cls: "lan-sync-muted", text: "手机浏览器打开上面地址可直接下载插件并验证网络；把该 IP / 端口 / 配对码填到手机端。带 VMware/VirtualBox 字样的网卡不用管。" });
    }

    this.toggle(card, "Obsidian 启动时自动开服务", s.autoStartServer, (v) => (s.autoStartServer = v), "关闭后需手动启动。");

    this.number(card, "监听端口", s.port, (v) => {
      s.port = v;
      s.clientPort = v;
    }, { desc: "默认 28900；被占用会自动顺延。", min: 1024, max: 65535 });

    this.text(card, "配对码", s.token, (v) => {
      const clean = v.replace(/\D/g, "").slice(0, 8);
      s.token = clean;
      s.clientToken = clean;
    }, { desc: "6 位数字，手机端需一致；改后重启服务。", placeholder: "6 位数字" });

    this.buttons(card, "服务控制", [
      {
        text: running ? "停止服务" : "启动服务",
        onClick: async () => {
          try {
            if (this.plugin.server) await this.plugin.stopServer();
            else await this.plugin.startServer();
          } catch (err) {
            new Notice(`操作失败：${errMsg(err)}`);
          }
          this.display();
        },
      },
      {
        text: "重启服务",
        onClick: async () => {
          try {
            await this.plugin.restartServer();
          } catch (err) {
            new Notice(`重启失败：${errMsg(err)}`);
          }
          this.display();
        },
      },
      {
        text: "复制地址",
        onClick: async () => {
          const url = this.plugin.server?.urls[0];
          if (!url) {
            new Notice("服务未启动");
            return;
          }
          await navigator.clipboard.writeText(url).catch(() => undefined);
          new Notice("已复制");
        },
      },
    ]);
  }

  // ---------- 客户端 · 网络自检 ----------

  private renderSelfTestSection(parent: HTMLElement): void {
    const s = this.plugin.settings;
    const card = this.card(
      parent,
      "网络自检（电脑直连兜底）",
      Platform.isDesktopApp ? "可留空测本机，或填局域网 IP 测真实链路。" : "填电脑的 192.168.x.x 地址和配对码，再点「完整自检」。"
    );

    this.text(card, "电脑 IP", s.clientHost, (v) => (s.clientHost = v.trim()), { desc: "只填 IP / 主机名，不要 http:// 与端口。", placeholder: "192.168.1.5" });

    this.number(card, "端口", s.clientPort, (v) => (s.clientPort = v), { placeholder: "28900", min: 1024, max: 65535 });

    this.text(card, "配对码", s.clientToken, (v) => (s.clientToken = v.replace(/\D/g, "").slice(0, 8)), { placeholder: "6 位数字" });

    this.buttons(
      card,
      "开始测试",
      [
        {
          text: "仅测连通",
          onClick: async () => {
            try {
              const target = this.plugin.resolveTarget();
              const a = await pingWithRequestUrl(target);
              const b = await pingWithFetch(target);
              new Notice(`${a.ok ? "✓" : "✗"} requestUrl（${a.ms}ms）\n${b.ok ? "✓" : "✗"} fetch（${b.ms}ms）`, 8000);
              this.plugin.log(`连通测试：requestUrl=${a.ok} fetch=${b.ok}`);
            } catch (err) {
              new Notice(errMsg(err));
            }
          },
        },
        { text: "完整自检", cta: true, onClick: () => this.plugin.runSelfTest() },
      ],
      "完整自检：requestUrl、fetch、分块下载、写盘、上传。"
    );
  }

  // ---------- 运行日志 ----------

  private renderLogSection(parent: HTMLElement): void {
    const card = this.card(parent, "运行日志", "同步结果、自检与错误都在这里。");
    this.logEl = card.createEl("pre", { cls: "lan-sync-log" });
    this.refreshLog();

    this.buttons(card, "复制日志", [
      {
        text: "复制",
        onClick: async () => {
          const text = this.plugin.logs.slice(-200).join("\n");
          if (!text) {
            new Notice("暂无日志");
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
            new Notice(`已复制 ${Math.min(this.plugin.logs.length, 200)} 行日志`);
          } catch {
            new Notice("复制失败，请长按日志手动选择复制");
          }
        },
      },
    ], "复制最近 200 行。");

    this.buttons(card, "临时文件", [{ text: "清理", onClick: () => this.plugin.cleanTempFiles() }], "自检会在插件 tmp 目录写测试文件。");
  }

  refreshLog(): void {
    if (!this.logEl) return;
    this.logEl.setText(this.plugin.logs.slice(-60).join("\n") || "（暂无日志）");
  }
}
