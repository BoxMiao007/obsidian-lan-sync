/**
 * 端到端测试：真实 HTTP 服务 + 真实文件系统适配器，跑完整的「拉取」流程。
 * 这不是 mock：服务端读一个临时目录，客户端写另一个临时目录。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSyncServer, buildManifest, planSync, applyPullPlan, emptyBaseline } = (() => {
  const server = require("../dist/server.cjs");
  const core = require("../dist/core.cjs");
  return { ...server, ...core };
})();

const IGNORE = { configDir: ".obsidian", selfPluginId: "lan-sync" };
const TOKEN = "445566";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content, mtimeSeconds) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeSeconds) fs.utimesSync(abs, mtimeSeconds, mtimeSeconds);
}

function createNodeAdapter(root) {
  const abs = (p) => path.join(root, p.replace(/\//g, path.sep));
  return {
    async exists(p) {
      return fs.existsSync(abs(p));
    },
    async stat(p) {
      try {
        const st = fs.statSync(abs(p));
        return {
          type: st.isDirectory() ? "folder" : "file",
          size: st.size,
          mtime: Math.trunc(st.mtimeMs),
          ctime: Math.trunc(st.ctimeMs),
        };
      } catch {
        return null;
      }
    },
    async list(p) {
      const dir = abs(p);
      const out = { files: [], folders: [] };
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const ent of entries) {
        const rel = p ? `${p}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.folders.push(rel);
        else out.files.push(rel);
      }
      return out;
    },
    async readBinary(p) {
      const buf = fs.readFileSync(abs(p));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async writeBinary(p, data) {
      fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
      fs.writeFileSync(abs(p), Buffer.from(data));
    },
    async appendBinary(p, data) {
      fs.appendFileSync(abs(p), Buffer.from(data));
    },
    async mkdir(p) {
      fs.mkdirSync(abs(p), { recursive: true });
    },
    async remove(p) {
      fs.rmSync(abs(p), { force: true, recursive: true });
    },
    async rename(from, to) {
      fs.mkdirSync(path.dirname(abs(to)), { recursive: true });
      fs.renameSync(abs(from), abs(to));
    },
  };
}

function makeDownloader(base, chunkBytes = 64 * 1024) {
  return {
    async downloadFile(filePath, size, onChunk) {
      let offset = 0;
      let fileSha = null;
      while (offset < size) {
        const len = Math.min(chunkBytes, size - offset);
        const url = `${base}/api/v1/file?path=${encodeURIComponent(filePath)}&offset=${offset}&len=${len}`;
        const resp = await fetch(url, { headers: { "x-lan-sync-token": TOKEN } });
        assert.equal(resp.status, 200, `下载 ${filePath}@${offset}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        assert.equal(buf.length, len);
        fileSha = resp.headers.get("x-file-sha256") || fileSha;
        await onChunk({
          chunk: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          offset,
        });
        offset += len;
      }
      return { fileSha, bytes: offset };
    },
  };
}

async function pullOnce(serverBase, localRoot) {
  const adapter = createNodeAdapter(localRoot);
  const local = await buildManifest(adapter, { ignore: IGNORE });
  const resp = await fetch(`${serverBase}/api/v1/manifest`, {
    headers: { "x-lan-sync-token": TOKEN },
  });
  assert.equal(resp.status, 200);
  const remote = await resp.json();
  const baselinePath = path.join(localRoot, ".baseline.json");
  const baseline = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : emptyBaseline();
  const plan = planSync(local.entries, remote.entries, baseline, { mode: "pull" });
  const result = await applyPullPlan(adapter, makeDownloader(serverBase), plan, baseline, {
    tmpDir: ".obsidian/plugins/lan-sync/tmp",
    remoteEntries: remote.entries,
  });
  fs.writeFileSync(baselinePath, JSON.stringify(result.newBaseline));
  return { plan, result };
}

test("端到端：首次拉取建立镜像，忽略项不进清单", async () => {
  const remoteRoot = makeTempDir("lan-remote-");
  const localRoot = makeTempDir("lan-local-");
  writeFile(remoteRoot, "notes/a.md", "# A\nhello");
  writeFile(remoteRoot, "notes/sub/b.md", "B content");
  writeFile(remoteRoot, "Assets/pic.bin", Buffer.alloc(300 * 1024, 7));
  writeFile(remoteRoot, ".git/config", "should be ignored");
  writeFile(remoteRoot, ".obsidian/workspace.json", "{}");
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/data.json", "{}");
  writeFile(remoteRoot, ".obsidian/app.json", '{"theme":"dark"}');

  const handle = await createSyncServer({
    port: 39300,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { plan, result } = await pullOnce(base, localRoot);
    assert.equal(plan.breaker, null);
    assert.deepEqual(plan.downloads.map((d) => d.path).sort(), [
      ".obsidian/app.json",
      "Assets/pic.bin",
      "notes/a.md",
      "notes/sub/b.md",
    ]);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));

    assert.equal(fs.readFileSync(path.join(localRoot, "notes/a.md"), "utf8"), "# A\nhello");
    assert.equal(fs.readFileSync(path.join(localRoot, "notes/sub/b.md"), "utf8"), "B content");
    assert.equal(fs.statSync(path.join(localRoot, "Assets/pic.bin")).size, 300 * 1024);
    assert.equal(fs.existsSync(path.join(localRoot, ".git/config")), false);
    assert.equal(fs.existsSync(path.join(localRoot, ".obsidian/workspace.json")), false);
    assert.equal(fs.existsSync(path.join(localRoot, ".obsidian/plugins/lan-sync/data.json")), false);
    assert.equal(fs.readFileSync(path.join(localRoot, ".obsidian/app.json"), "utf8"), '{"theme":"dark"}');

    // 第二次同步：应该全部未变，不重复下载
    const second = await pullOnce(base, localRoot);
    assert.equal(second.plan.downloads.length, 0);
    assert.equal(second.plan.deleteLocal.length, 0);
    assert.equal(second.result.bytes, 0);
  } finally {
    await handle.close();
  }
});

test("端到端：远端修改 → 只下载变化的文件；远端删除 → 删除本机", async () => {
  const remoteRoot = makeTempDir("lan-remote2-");
  const localRoot = makeTempDir("lan-local2-");
  writeFile(remoteRoot, "a.md", "v1", 1700000000);
  writeFile(remoteRoot, "b.md", "v1", 1700000000);
  writeFile(remoteRoot, "c.md", "v1", 1700000000);

  const handle = await createSyncServer({
    port: 39301,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);

    writeFile(remoteRoot, "a.md", "v2 changed", 1700000100);
    fs.rmSync(path.join(remoteRoot, "b.md"));

    const { plan, result } = await pullOnce(base, localRoot);
    assert.deepEqual(plan.downloads.map((d) => d.path), ["a.md"]);
    assert.deepEqual(plan.deleteLocal, ["b.md"]);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(fs.readFileSync(path.join(localRoot, "a.md"), "utf8"), "v2 changed");
    assert.equal(fs.existsSync(path.join(localRoot, "b.md")), false);
    assert.equal(fs.existsSync(path.join(localRoot, "c.md")), true);
  } finally {
    await handle.close();
  }
});

test("端到端：大批量删除触发熔断，一个文件都不动", async () => {
  const remoteRoot = makeTempDir("lan-remote3-");
  const localRoot = makeTempDir("lan-local3-");
  for (let i = 0; i < 25; i++) writeFile(remoteRoot, `f${i}.md`, `content ${i}`, 1700000000);

  const handle = await createSyncServer({
    port: 39302,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);
    assert.equal(fs.readdirSync(localRoot).filter((f) => f.endsWith(".md")).length, 25);

    for (let i = 0; i < 25; i++) fs.rmSync(path.join(remoteRoot, `f${i}.md`));
    const { plan, result } = await pullOnce(base, localRoot);
    assert.ok(plan.breaker, "25 个文件同时消失应触发熔断");
    assert.equal(result.appliedDeletes.length, 0, "熔断时不应执行任何删除");
    assert.equal(fs.readdirSync(localRoot).filter((f) => f.endsWith(".md")).length, 25);
  } finally {
    await handle.close();
  }
});

test("端到端：本机改动不会被 pull 覆盖", async () => {
  const remoteRoot = makeTempDir("lan-remote4-");
  const localRoot = makeTempDir("lan-local4-");
  writeFile(remoteRoot, "a.md", "remote v1", 1700000000);

  const handle = await createSyncServer({
    port: 39303,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);
    writeFile(localRoot, "a.md", "local edit", 1700000200);

    const { plan, result } = await pullOnce(base, localRoot);
    assert.equal(plan.downloads.length, 0, "本机改过的文件不应被远端覆盖");
    assert.ok(plan.skipped.some((s) => s.path === "a.md"));
    assert.equal(fs.readFileSync(path.join(localRoot, "a.md"), "utf8"), "local edit");
    assert.equal(result.bytes, 0);
  } finally {
    await handle.close();
  }
});
