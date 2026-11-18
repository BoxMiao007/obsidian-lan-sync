const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isIgnored,
  normalizeVaultPath,
  planSync,
  updateBaseline,
  emptyBaseline,
  buildManifest,
} = require("../dist/core.cjs");

const IGNORE = { configDir: ".obsidian", selfPluginId: "lan-sync" };

test("路径规范化：反斜杠、前导斜杠、末尾斜杠", () => {
  assert.equal(normalizeVaultPath(".\\notes\\a.md"), "notes/a.md");
  assert.equal(normalizeVaultPath("/notes/a.md"), "notes/a.md");
  assert.equal(normalizeVaultPath("notes/a.md/"), "notes/a.md");
});

test("忽略规则：git/trash/工作区/本插件自身", () => {
  const ignored = [
    ".git",
    ".git/config",
    ".git/objects/aa/bb",
    ".trash/abc.md",
    ".DS_Store",
    "desktop.ini",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/plugins/lan-sync/main.js",
    ".obsidian/plugins/lan-sync/data.json",
    ".obsidian/plugins/lan-sync/tmp/x.part",
    ".obsidian/plugins/nutstore-sync/data.json",
    ".obsidian/plugins/obsidian-git/data.json",
    ".obsidian/plugins/obsidian-git/obsidian_askpass.sh",
  ];
  for (const path of ignored) {
    assert.equal(isIgnored(path, IGNORE), true, `应忽略：${path}`);
  }
});

test("忽略规则：正常笔记与其它插件不被误伤", () => {
  const kept = [
    "README.md",
    "日记/2026-11-18.md",
    "Assets/图片.png",
    ".obsidian/app.json",
    ".obsidian/plugins/obsidian-git/main.js",
    ".obsidian/plugins/obsidian-git/manifest.json",
    "notes/.git.md",
  ];
  for (const path of kept) {
    assert.equal(isIgnored(path, IGNORE), false, `不应忽略：${path}`);
  }
});

test("忽略规则：显式开启后才同步插件 data.json", () => {
  const cfg = { ...IGNORE, syncPluginData: true };
  assert.equal(isIgnored(".obsidian/plugins/nutstore-sync/data.json", cfg), false);
  assert.equal(isIgnored(".obsidian/plugins/lan-sync/data.json", cfg), true, "本插件自身永远不同步");
  assert.equal(isIgnored(".obsidian/plugins/obsidian-git/obsidian_askpass.sh", cfg), true);
});

test("忽略规则：自定义 glob", () => {
  const cfg = { ...IGNORE, extraPatterns: ["**/node_modules/**", "*.tmp"] };
  assert.equal(isIgnored("a/node_modules/b/c.js", cfg), true);
  assert.equal(isIgnored("node_modules/x.js", cfg), true);
  assert.equal(isIgnored("a/b.tmp", cfg), true);
  assert.equal(isIgnored("a/b.md", cfg), false);
});

const entry = (path, sha, size = 10) => ({ path, sha256: sha, size, mtime: 1 });
const baseOf = (map) => ({
  version: 1,
  updatedAt: 0,
  entries: Object.fromEntries(Object.entries(map).map(([p, sha]) => [p, { size: 10, sha256: sha }])),
});

test("计划：远端新增 → 下载", () => {
  const plan = planSync([], [entry("a.md", "r1")], emptyBaseline(), { mode: "both" });
  assert.deepEqual(plan.downloads.map((d) => d.path), ["a.md"]);
});

test("计划：内容相同 → 不变", () => {
  const plan = planSync([entry("a.md", "same")], [entry("a.md", "same")], emptyBaseline(), { mode: "both" });
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.downloads.length + plan.uploads.length, 0);
});

test("计划：远端修改 → 下载；本机修改 → 上传", () => {
  const base = baseOf({ "a.md": "v1", "b.md": "v1" });
  const plan = planSync(
    [entry("a.md", "v2-local"), entry("b.md", "v1")],
    [entry("a.md", "v1"), entry("b.md", "v2-remote")],
    base,
    { mode: "both" }
  );
  assert.deepEqual(plan.uploads.map((d) => d.path), ["a.md"]);
  assert.deepEqual(plan.downloads.map((d) => d.path), ["b.md"]);
});

test("计划：两端都改 → 冲突，不自动覆盖", () => {
  const base = baseOf({ "a.md": "v1" });
  const plan = planSync([entry("a.md", "v2-local")], [entry("a.md", "v2-remote")], base, { mode: "both" });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, "both-modified");
  assert.equal(plan.downloads.length + plan.uploads.length, 0);
});

test("计划：首次同步两边都有但内容不同 → 冲突 no-base", () => {
  const plan = planSync([entry("a.md", "x")], [entry("a.md", "y")], emptyBaseline(), { mode: "both" });
  assert.equal(plan.conflicts[0].reason, "no-base");
});

test("计划：远端删除 → 删本机；本机删除 → 删远端", () => {
  const base = baseOf({ "a.md": "v1", "b.md": "v1" });
  const plan = planSync([entry("b.md", "v1")], [entry("a.md", "v1")], base, { mode: "both" });
  assert.deepEqual(plan.deleteLocal, ["b.md"], "b.md 只在本地 → 远端删了它 → 删本地");
  assert.deepEqual(plan.deleteRemote, ["a.md"], "a.md 只在远端 → 本地删了它 → 删远端");
});

test("计划：pull 模式不推送本机改动", () => {
  const base = baseOf({ "a.md": "v1" });
  const plan = planSync(
    [entry("a.md", "v2-local"), entry("new.md", "n1")],
    [entry("a.md", "v1")],
    base,
    { mode: "pull" }
  );
  assert.equal(plan.uploads.length, 0);
  assert.ok(plan.skipped.some((s) => s.path === "a.md"));
  assert.ok(plan.skipped.some((s) => s.path === "new.md"));
});

test("计划：删除熔断（数量阈值）", () => {
  const base = baseOf({});
  const remote = [];
  const local = [];
  for (let i = 0; i < 25; i++) {
    base.entries[`f${i}.md`] = { size: 10, sha256: "v1" };
    local.push(entry(`f${i}.md`, "v1"));
  }
  const plan = planSync(local, remote, base, { mode: "both" });
  assert.equal(plan.deleteLocal.length, 25);
  assert.ok(plan.breaker, "25 个删除应触发熔断");
});

test("计划：删除熔断（比例阈值）", () => {
  const base = baseOf({});
  const local = [];
  const remote = [];
  for (let i = 0; i < 30; i++) {
    base.entries[`f${i}.md`] = { size: 10, sha256: "v1" };
    local.push(entry(`f${i}.md`, "v1"));
  }
  // 30 个文件里 15 个被远端删除 = 50%，超过 30%
  for (let i = 0; i < 15; i++) remote.push(entry(`f${i}.md`, "v1"));
  const plan = planSync(local, remote, base, { mode: "both" });
  assert.equal(plan.deleteLocal.length, 15);
  assert.ok(plan.breaker, "30 个文件删 15 个（50%）应触发熔断");

  const plan2 = planSync(local, local.map((e) => entry(e.path, "v1")), base, { mode: "both" });
  assert.equal(plan2.breaker, null);
});

test("计划：小库不按比例熔断（3 个删 1 个属正常）", () => {
  const base = baseOf({ "a.md": "v1", "b.md": "v1", "c.md": "v1" });
  const plan = planSync(
    [entry("a.md", "v1"), entry("b.md", "v1"), entry("c.md", "v1")],
    [entry("a.md", "v1"), entry("b.md", "v1")],
    base,
    { mode: "both" }
  );
  assert.equal(plan.deleteLocal.length, 1);
  assert.equal(plan.breaker, null);
});

test("基线更新：下载写入、删除移除、未变补齐", () => {
  const baseline = baseOf({ "old.md": "v1" });
  const updated = updateBaseline(
    baseline,
    [{ path: "new.md", size: 12, sha256: "r1", mtime: 0 }],
    ["old.md"],
    [entry("same.md", "s1")]
  );
  assert.deepEqual(Object.keys(updated.entries).sort(), ["new.md", "same.md"]);
  assert.equal(updated.entries["new.md"].sha256, "r1");
});

test("manifest：递归扫描、跳过忽略项、超大文件不算哈希", async () => {
  const tree = {
    "a.md": "hello",
    "dir/b.md": "world",
    ".git/config": "x",
    ".obsidian/plugins/lan-sync/main.js": "x",
    ".obsidian/app.json": "{}",
    "big.bin": "0123456789",
  };
  const adapter = makeMemoryAdapter(tree);
  const manifest = await buildManifest(adapter, { ignore: IGNORE, maxHashBytes: 8 });
  const paths = manifest.entries.map((e) => e.path).sort();
  assert.deepEqual(paths, [".obsidian/app.json", "a.md", "big.bin", "dir/b.md"]);
  const big = manifest.entries.find((e) => e.path === "big.bin");
  assert.equal(big.sha256, null, "超过 8 字节的文件不应计算哈希");
  const a = manifest.entries.find((e) => e.path === "a.md");
  assert.ok(a.sha256 && a.sha256.length === 64);
});

function makeMemoryAdapter(tree) {
  const files = new Map(Object.entries(tree));
  const dirs = new Set([""]);
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    async exists(path) {
      return files.has(path) || dirs.has(path);
    },
    async stat(path) {
      if (files.has(path)) {
        const data = files.get(path);
        return { type: "file", size: data.length, mtime: 1, ctime: 1 };
      }
      return dirs.has(path) ? { type: "folder", size: 0, mtime: 1, ctime: 1 } : null;
    },
    async list(path) {
      const prefix = path ? `${path}/` : "";
      const out = { files: [], folders: [] };
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest.includes("/")) out.files.push(file);
      }
      for (const dir of dirs) {
        if (!dir || !dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        if (rest && !rest.includes("/") && dir !== path) out.folders.push(dir);
      }
      return out;
    },
    async readBinary(path) {
      const data = files.get(path) || "";
      return new TextEncoder().encode(data).buffer;
    },
  };
}

test("计划：小库也不能被「另一端清空」全部删掉", () => {
  const base = baseOf({ "a.md": "v1", "b.md": "v1", "c.md": "v1", "d.md": "v1", "e.md": "v1" });
  const local = Object.keys(base.entries).map((p) => entry(p, "v1"));
  const plan = planSync(local, [], base, { mode: "both" });
  assert.equal(plan.deleteLocal.length, 5);
  assert.ok(plan.breaker, "5 个文件全删、占基线 100%，必须熔断");
  assert.match(plan.breaker.message, /基线/);
});

test("计划：正常改动少量文件不触发基线半数熔断", () => {
  const base = baseOf({});
  const local = [];
  const remote = [];
  for (let i = 0; i < 6; i++) {
    base.entries[`f${i}.md`] = { size: 10, sha256: "v1" };
    local.push(entry(`f${i}.md`, "v1"));
    remote.push(entry(`f${i}.md`, "v1"));
  }
  // 电脑端 6 个里删 2 个（本机删 2 个，<3 个）不熔断；删 4 个（>=3 且超半数）应熔断
  const plan2 = planSync(local, remote.slice(0, 4), base, { mode: "both" });
  assert.equal(plan2.deleteLocal.length, 2);
  assert.equal(plan2.breaker, null);

  const plan3 = planSync(local, remote.slice(0, 2), base, { mode: "both" });
  assert.equal(plan3.deleteLocal.length, 4);
  assert.ok(plan3.breaker, "6 个删 4 个（>半数且>=3）应熔断");
});

test("计划：首次同步可选「以电脑为准」批量覆盖", () => {
  const local = [entry("a.md", "local-a"), entry("b.md", "same")];
  const remote = [entry("a.md", "remote-a"), entry("b.md", "same")];

  const asConflict = planSync(local, remote, emptyBaseline(), { mode: "both" });
  assert.equal(asConflict.conflicts.length, 1);

  const preferRemote = planSync(local, remote, emptyBaseline(), {
    mode: "both",
    noBaseStrategy: "prefer-remote",
  });
  assert.deepEqual(preferRemote.downloads.map((d) => d.path), ["a.md"]);
  assert.equal(preferRemote.conflicts.length, 0);

  const preferLocal = planSync(local, remote, emptyBaseline(), {
    mode: "both",
    noBaseStrategy: "prefer-local",
  });
  assert.deepEqual(preferLocal.uploads.map((u) => u.path), ["a.md"]);
  assert.equal(preferLocal.conflicts.length, 0);
});
