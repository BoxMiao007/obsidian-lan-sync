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
};

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
    containerEl.createEl("p", {
      cls: "lan-sync-muted",
      text: "同一 Wi-Fi 下，手机直接连电脑同步，不经过任何云服务。当前为 spike 版：只验证网络与写盘能力，还不同步笔记。",
    });

    this.renderServerSection(containerEl);
    this.renderClientSection(containerEl);
    this.renderLogSection(containerEl);
  }

  private renderServerSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lan-sync-card" });
    card.createEl("h3", { text: "电脑端 · 服务端" });

    if (!Platform.isDesktopApp) {
      card.createEl("p", {
        cls: "lan-sync-muted",
        text: "手机端没有 Node 运行环境，无法监听端口。服务端只在电脑上运行，手机作为客户端连接。",
      });
      return;
    }

    const running = Boolean(this.plugin.server);
    card.createEl("p", {
      cls: running ? "lan-sync-ok" : "lan-sync-warn",
      text: running
        ? `运行中 · 端口 ${this.plugin.server?.port}`
        : "未启动（点下方按钮启动）",
    });

    if (running && this.plugin.server) {
      for (const addr of this.plugin.server.addresses) {
        card.createEl("div", { cls: "lan-sync-url", text: `${addr.url}    （${addr.name}）` });
      }
      const lanUrl = this.plugin.server.addresses[0]?.url || this.plugin.server.urls[0];
      card.createEl("p", {
        cls: "lan-sync-muted",
        text: "手机浏览器打开下面这个地址，可以直接下载插件文件并验证网络：",
      });
      card.createEl("div", {
        cls: "lan-sync-url",
        text: `${lanUrl}/?token=${this.plugin.settings.token}`,
      });
      card.createEl("p", {
        cls: "lan-sync-muted",
        text: `把上面的 IP / 端口 / 配对码填到手机端的插件设置里。带 VMware/VirtualBox 字样的网卡不用管。`,
      });
    }

    new Setting(card)
      .setName("Obsidian 启动时自动开服务")
      .setDesc("关闭后需要手动点「启动服务」。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStartServer).onChange(async (value) => {
          this.plugin.settings.autoStartServer = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(card)
      .setName("监听端口")
      .setDesc("默认 28900；被占用时会自动顺延到下一个可用端口。")
      .addText((text) =>
        text
          .setPlaceholder("28900")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535) {
              this.plugin.settings.port = parsed;
              this.plugin.settings.clientPort = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(card)
      .setName("配对码")
      .setDesc("6 位数字，手机端必须填一致；请求带签名，改完需要重启服务。")
      .addText((text) =>
        text
          .setPlaceholder("6 位数字")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            const clean = value.replace(/\D/g, "").slice(0, 8);
            this.plugin.settings.token = clean;
            this.plugin.settings.clientToken = clean;
            await this.plugin.saveSettings();
          })
      );

    new Setting(card)
      .setName("服务控制")
      .addButton((btn) =>
        btn.setButtonText(running ? "停止服务" : "启动服务").onClick(async () => {
          try {
            if (this.plugin.server) await this.plugin.stopServer();
            else await this.plugin.startServer();
          } catch (err) {
            new Notice(`操作失败：${errMsg(err)}`);
          }
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("重启服务").onClick(async () => {
          try {
            await this.plugin.restartServer();
          } catch (err) {
            new Notice(`重启失败：${errMsg(err)}`);
          }
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("复制地址").onClick(async () => {
          const url = this.plugin.server?.urls[0];
          if (!url) {
            new Notice("服务未启动");
            return;
          }
          await navigator.clipboard.writeText(url).catch(() => undefined);
          new Notice("已复制");
        })
      );
  }

  private renderClientSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lan-sync-card" });
    card.createEl("h3", { text: "客户端 · 网络自检" });
    card.createEl("p", {
      cls: "lan-sync-muted",
      text: Platform.isDesktopApp
        ? "电脑上可以留空地址，直接测本机服务；也可以填局域网 IP 测真实链路。"
        : "填写电脑上显示的 192.168.x.x 地址和配对码，然后点「完整自检」。",
    });

    new Setting(card)
      .setName("电脑 IP")
      .setDesc("只填 IP 或主机名，不要带 http:// 和端口。")
      .addText((text) =>
        text
          .setPlaceholder("192.168.1.5")
          .setValue(this.plugin.settings.clientHost)
          .onChange(async (value) => {
            this.plugin.settings.clientHost = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(card)
      .setName("端口")
      .addText((text) =>
        text
          .setPlaceholder("28900")
          .setValue(String(this.plugin.settings.clientPort))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535) {
              this.plugin.settings.clientPort = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(card)
      .setName("配对码")
      .addText((text) =>
        text
          .setPlaceholder("6 位数字")
          .setValue(this.plugin.settings.clientToken)
          .onChange(async (value) => {
            this.plugin.settings.clientToken = value.replace(/\D/g, "").slice(0, 8);
            await this.plugin.saveSettings();
          })
      );

    new Setting(card)
      .setName("开始测试")
      .setDesc("「完整自检」会依次测：requestUrl、fetch、1MB/8MB 分块下载、写盘、2MB 上传。")
      .addButton((btn) =>
        btn
          .setButtonText("仅测连通")
          .onClick(async () => {
            try {
              const target = this.plugin.resolveTarget();
              const a = await pingWithRequestUrl(target);
              const b = await pingWithFetch(target);
              new Notice(
                `${a.ok ? "✓" : "✗"} requestUrl（${a.ms}ms）\n${b.ok ? "✓" : "✗"} fetch（${b.ms}ms）`,
                8000
              );
              this.plugin.log(`连通测试：requestUrl=${a.ok} fetch=${b.ok}`);
            } catch (err) {
              new Notice(errMsg(err));
            }
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("完整自检")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSelfTest();
          })
      );

    new Setting(card)
      .setName("同步方向")
      .setDesc("pull = 只把电脑改动拉到本机；push = 只把本机改动推到电脑；both = 双向（推荐最终使用）")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            pull: "只拉取（电脑 → 本机）",
            push: "只推送（本机 → 电脑）",
            both: "双向",
          })
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as "pull" | "push" | "both";
            await this.plugin.saveSettings();
          })
      );

    new Setting(card)
      .setName("同步")
      .setDesc("先预览差异，确认后才写入。")
      .addButton((btn) =>
        btn
          .setButtonText("立即同步")
          .setCta()
          .onClick(async () => {
            await this.plugin.runSync();
          })
      );

    new Setting(card)
      .setName("分块大小")
      .setDesc("默认 4MB。手机自检如果 8MB 失败，调成 1–2MB。")
      .addText((text) =>
        text
          .setPlaceholder("4")
          .setValue(String(this.plugin.settings.chunkMB))
          .onChange(async (value) => {
            const parsed = parseFloat(value);
            if (Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 16) {
              this.plugin.settings.chunkMB = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(card)
      .setName("删除保护阈值")
      .setDesc("一次同步要删除超过这么多文件就中止，防止误删/换机清空。")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.maxDeletes))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000) {
              this.plugin.settings.maxDeletes = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(card)
      .setName("自动同步总开关")
      .setDesc("关闭后只有手动点「立即同步」才会同步。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncEnabled).onChange(async (value) => {
          this.plugin.settings.syncEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(card)
      .setName("打开 app 时自动同步")
      .setDesc("手机端每次打开 Obsidian 后自动拉一次（首次同步仍会先让你确认）。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnOpen).onChange(async (value) => {
          this.plugin.settings.syncOnOpen = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(card)
      .setName("文件变更后自动同步")
      .setDesc("编辑停止多少秒后自动同步；0 = 关闭。手机端仅在 Obsidian 处于前台时有效。")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.syncDebounceSeconds))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 600) {
              this.plugin.settings.syncDebounceSeconds = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(card)
      .setName("定时同步")
      .setDesc("每隔多少分钟同步一次；0 = 关闭。")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1440) {
              this.plugin.settings.syncIntervalMinutes = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(card)
      .setName("同步第三方插件设置（危险）")
      .setDesc(
        "默认关闭。开启后会把各插件的 data.json 一并同步，而其中可能含坚果云、GitHub 等第三方服务的密码/令牌，局域网明文传输有泄露风险。"
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncPluginData).onChange(async (value) => {
          this.plugin.settings.syncPluginData = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderLogSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "lan-sync-card" });
    card.createEl("h3", { text: "运行日志" });
    this.logEl = card.createEl("pre", { cls: "lan-sync-log" });
    this.refreshLog();
    new Setting(card)
      .setName("临时文件")
      .setDesc("自检会在 .obsidian/plugins/lan-sync/tmp 下写测试文件，可随时清理。")
      .addButton((btn) =>
        btn.setButtonText("清理").onClick(async () => {
          await this.plugin.cleanTempFiles();
        })
      );
  }

  refreshLog(): void {
    if (!this.logEl) return;
    this.logEl.setText(this.plugin.logs.slice(-12).join("\n") || "（暂无日志）");
  }
}
