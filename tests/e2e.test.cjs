/**
 * 端到端测试：真实 HTTP 服务 + 真实文件系统适配器，跑完整的「拉取」流程。
 * 这不是 mock：服务端读一个临时目录，客户端写另一个临时目录。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const { createSyncServer, buildManifest, planSync, applyPullPlan, applyPushPlan, applyConflictChoice, emptyBaseline } = (() => {
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

function makeDownloader(base, sessionId, chunkBytes = 64 * 1024) {
  return {
    async downloadFile(filePath, size, onChunk) {
      let offset = 0;
      let fileSha = null;
      while (offset < size) {
        const len = Math.min(chunkBytes, size - offset);
        const url = `${base}/api/v1/file?path=${encodeURIComponent(filePath)}&offset=${offset}&len=${len}`;
        const resp = await fetch(url, {
          headers: { "x-lan-sync-token": TOKEN, "x-lan-sync-session": sessionId },
        });
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

function makeUploader(base, sessionId) {
  const baseHeaders = { "x-lan-sync-token": TOKEN, "x-lan-sync-session": sessionId };
  return {
    async initUpload(filePath, size, sha256) {
      const resp = await fetch(`${base}/api/v1/upload/init`, {
        method: "POST",
        headers: { ...baseHeaders, "content-type": "application/json" },
        body: JSON.stringify({ path: filePath, size, sha256 }),
      });
      assert.equal(resp.status, 200);
      const body = await resp.json();
      return body.uploadId;
    },
    async uploadChunk(uploadId, offset, chunk) {
      const resp = await fetch(`${base}/api/v1/upload/chunk?uploadId=${uploadId}&offset=${offset}`, {
        method: "POST",
        headers: baseHeaders,
        body: Buffer.from(chunk),
      });
      assert.equal(resp.status, 200);
    },
    async finishUpload(uploadId) {
      const resp = await fetch(`${base}/api/v1/upload/finish?uploadId=${uploadId}`, {
        method: "POST",
        headers: baseHeaders,
      });
      assert.equal(resp.status, 200);
      const body = await resp.json();
      return { size: body.entry.size, sha256: body.entry.sha256 };
    },
    async deleteRemote(filePath) {
      const resp = await fetch(`${base}/api/v1/file?path=${encodeURIComponent(filePath)}`, {
        method: "DELETE",
        headers: baseHeaders,
      });
      assert.equal(resp.status, 200);
    },
  };
}

async function syncOnce(serverBase, localRoot, baselinePath = `${localRoot}.baseline.json`, mode = "pull") {
  const startResp = await fetch(`${serverBase}/api/v1/session/start`, {
    method: "POST",
    headers: { "x-lan-sync-token": TOKEN },
  });
  assert.equal(startResp.status, 200, "应能建立同步会话");
  const { sessionId } = await startResp.json();
  const sessionHeaders = { "x-lan-sync-token": TOKEN, "x-lan-sync-session": sessionId };

  try {
    const adapter = createNodeAdapter(localRoot);
    const local = await buildManifest(adapter, { ignore: IGNORE });
    const resp = await fetch(`${serverBase}/api/v1/manifest`, { headers: sessionHeaders });
    assert.equal(resp.status, 200);
    const remote = await resp.json();
    const baseline = fs.existsSync(baselinePath)
      ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
      : emptyBaseline();
    const plan = planSync(local.entries, remote.entries, baseline, { mode });
    let result;
    if (mode === "push") {
      result = await applyPushPlan(adapter, makeUploader(serverBase, sessionId), plan, baseline, {
        remoteEntries: remote.entries,
        chunkBytes: 64 * 1024,
      });
    } else {
      result = await applyPullPlan(adapter, makeDownloader(serverBase, sessionId), plan, baseline, {
        tmpDir: ".obsidian/plugins/lan-sync/tmp",
        remoteEntries: remote.entries,
      });
    }
    fs.writeFileSync(baselinePath, JSON.stringify(result.newBaseline));
    return { plan, result };
  } finally {
    await fetch(`${serverBase}/api/v1/session/end?sessionId=${sessionId}`, {
      method: "POST",
      headers: sessionHeaders,
    });
  }
}

async function pullOnce(serverBase, localRoot, baselinePath = `${localRoot}.baseline.json`) {
  return syncOnce(serverBase, localRoot, baselinePath, "pull");
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

test("端到端：本机改动不会被 pull 覆盖", async () => {  const remoteRoot = makeTempDir("lan-remote4-");
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

test("端到端：push 把本机修改/新增/删除推到电脑", async () => {
  const remoteRoot = makeTempDir("lan-remote5-");
  const localRoot = makeTempDir("lan-local5-");
  writeFile(remoteRoot, "a.md", "v1", 1700000000);
  writeFile(remoteRoot, "b.md", "v1", 1700000000);
  writeFile(remoteRoot, "c.md", "v1", 1700000000);

  const handle = await createSyncServer({
    port: 39304,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);

    writeFile(localRoot, "a.md", "v2 local", 1700000300);
    writeFile(localRoot, "new.md", "brand new", 1700000300);
    fs.rmSync(path.join(localRoot, "c.md"));

    const { plan, result } = await syncOnce(base, localRoot, undefined, "push");
    assert.deepEqual(plan.uploads.map((u) => u.path).sort(), ["a.md", "new.md"]);
    assert.deepEqual(plan.deleteRemote, ["c.md"]);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(fs.readFileSync(path.join(remoteRoot, "a.md"), "utf8"), "v2 local");
    assert.equal(fs.readFileSync(path.join(remoteRoot, "new.md"), "utf8"), "brand new");
    assert.equal(fs.existsSync(path.join(remoteRoot, "c.md")), false);
    assert.equal(fs.readFileSync(path.join(localRoot, "b.md"), "utf8"), "v1");
  } finally {
    await handle.close();
  }
});

test("端到端：两端同时修改 → 冲突，双方文件原样保留", async () => {
  const remoteRoot = makeTempDir("lan-remote6-");
  const localRoot = makeTempDir("lan-local6-");
  writeFile(remoteRoot, "a.md", "base v1", 1700000000);

  const handle = await createSyncServer({
    port: 39305,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);

    writeFile(remoteRoot, "a.md", "remote v2", 1700000400);
    writeFile(localRoot, "a.md", "local v2", 1700000400);

    const { plan, result } = await syncOnce(base, localRoot, undefined, "both");
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].reason, "both-modified");
    assert.equal(plan.downloads.length + plan.uploads.length, 0);
    assert.equal(result.bytes, 0);
    assert.equal(fs.readFileSync(path.join(localRoot, "a.md"), "utf8"), "local v2");
    assert.equal(fs.readFileSync(path.join(remoteRoot, "a.md"), "utf8"), "remote v2");
  } finally {
    await handle.close();
  }
});

test("端到端：中文路径、空格、空文件、深目录", async () => {
  const remoteRoot = makeTempDir("lan-remote7-");
  const localRoot = makeTempDir("lan-local7-");
  writeFile(remoteRoot, "工具与配置/环境 部署.md", "中文内容");
  writeFile(remoteRoot, "empty.md", "");
  writeFile(remoteRoot, "a/b/c/d/e/deep.md", "deep");
  writeFile(remoteRoot, "带#号和%百分号.md", "special chars");

  const handle = await createSyncServer({
    port: 39306,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { plan, result } = await pullOnce(base, localRoot);
    assert.equal(plan.downloads.length, 4);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(fs.readFileSync(path.join(localRoot, "工具与配置/环境 部署.md"), "utf8"), "中文内容");
    assert.equal(fs.statSync(path.join(localRoot, "empty.md")).size, 0);
    assert.equal(fs.readFileSync(path.join(localRoot, "a/b/c/d/e/deep.md"), "utf8"), "deep");
    assert.equal(fs.readFileSync(path.join(localRoot, "带#号和%百分号.md"), "utf8"), "special chars");
  } finally {
    await handle.close();
  }
});

test("服务端拒绝路径穿越与非法路径", async () => {
  const remoteRoot = makeTempDir("lan-remote8-");
  writeFile(remoteRoot, "ok.md", "fine");
  const handle = await createSyncServer({
    port: 39307,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const start = await fetch(`${base}/api/v1/session/start`, {
      method: "POST",
      headers: { "x-lan-sync-token": TOKEN },
    });
    const { sessionId } = await start.json();
    const headers = { "x-lan-sync-token": TOKEN, "x-lan-sync-session": sessionId };

    const attacks = [
      "../../../etc/passwd",
      "..%2F..%2Fsecret.txt",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "..\\..\\windows\\win.ini",
    ];
    for (const attack of attacks) {
      const resp = await fetch(`${base}/api/v1/file?path=${encodeURIComponent(attack)}`, { headers });
      assert.ok(resp.status >= 400, `路径 ${attack} 应被拒绝，实际 ${resp.status}`);
    }

    // 忽略规则里的路径也不允许上传
    const init = await fetch(`${base}/api/v1/upload/init`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ path: ".git/config", size: 4 }),
    });
    assert.ok(init.status >= 400, ".git/config 上传应被拒绝");

    await fetch(`${base}/api/v1/session/end?sessionId=${sessionId}`, { method: "POST", headers });
  } finally {
    await handle.close();
  }
});

test("端到端：本机把文件重命名（删除+新增）能正确传播到电脑", async () => {
  const remoteRoot = makeTempDir("lan-remote9-");
  const localRoot = makeTempDir("lan-local9-");
  writeFile(remoteRoot, "旧名.md", "内容不变", 1700000000);

  const handle = await createSyncServer({
    port: 39308,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);

    fs.renameSync(path.join(localRoot, "旧名.md"), path.join(localRoot, "新名.md"));

    const { plan, result } = await syncOnce(base, localRoot, undefined, "push");
    assert.deepEqual(plan.uploads.map((u) => u.path), ["新名.md"]);
    assert.deepEqual(plan.deleteRemote, ["旧名.md"]);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(fs.readFileSync(path.join(remoteRoot, "新名.md"), "utf8"), "内容不变");
    assert.equal(fs.existsSync(path.join(remoteRoot, "旧名.md")), false);
  } finally {
    await handle.close();
  }
});

test("端到端：电脑端清单突然为空 → 熔断，一个本机文件都不删", async () => {
  const remoteRoot = makeTempDir("lan-remote10-");
  const localRoot = makeTempDir("lan-local10-");
  for (let i = 0; i < 5; i++) writeFile(remoteRoot, `n${i}.md`, `content ${i}`, 1700000000);

  const handle = await createSyncServer({
    port: 39309,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    await pullOnce(base, localRoot);
    assert.equal(fs.readdirSync(localRoot).filter((f) => f.endsWith(".md")).length, 5);

    for (let i = 0; i < 5; i++) fs.rmSync(path.join(remoteRoot, `n${i}.md`));
    const { plan, result } = await pullOnce(base, localRoot);
    assert.ok(plan.breaker, "电脑端清空应触发熔断");
    assert.equal(result.appliedDeletes.length, 0);
    assert.equal(fs.readdirSync(localRoot).filter((f) => f.endsWith(".md")).length, 5);
  } finally {
    await handle.close();
  }
});

test("冲突三选一：留电脑 / 留手机 / 两份都留", async () => {
  const remoteRoot = makeTempDir("lan-remote11-");
  const localRoot = makeTempDir("lan-local11-");

  const handle = await createSyncServer({
    port: 39310,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });
  const base = `http://127.0.0.1:${handle.port}`;

  const sha = (text) => sha256(Buffer.from(text));
  const mkConflict = (filePath, localContent, remoteContent) => ({
    path: filePath,
    reason: "both-modified",
    localSha: sha(localContent),
    remoteSha: sha(remoteContent),
    localSize: Buffer.byteLength(localContent),
    remoteSize: Buffer.byteLength(remoteContent),
  });

  async function runChoice(conflict, choice, makeCopyPath = (p) => `copy-${p}`) {
    return withSession(base, async (sessionId) => {
      const adapter = createNodeAdapter(localRoot);
      return applyConflictChoice(
        adapter,
        makeDownloader(base, sessionId),
        makeUploader(base, sessionId),
        conflict,
        choice,
        emptyBaseline(),
        { tmpDir: "tmp", makeCopyPath }
      );
    });
  }

  try {
    // 留电脑版本
    writeFile(remoteRoot, "x.md", "remote-x");
    writeFile(localRoot, "x.md", "local-x");
    const r1 = await runChoice(mkConflict("x.md", "local-x", "remote-x"), "remote");
    assert.equal(r1.errors.length, 0, JSON.stringify(r1.errors));
    assert.equal(fs.readFileSync(path.join(localRoot, "x.md"), "utf8"), "remote-x");

    // 留手机版本
    writeFile(localRoot, "y.md", "local-y");
    writeFile(remoteRoot, "y.md", "remote-y");
    const r2 = await runChoice(mkConflict("y.md", "local-y", "remote-y"), "local");
    assert.equal(r2.errors.length, 0, JSON.stringify(r2.errors));
    assert.equal(fs.readFileSync(path.join(remoteRoot, "y.md"), "utf8"), "local-y");

    // 两份都留
    writeFile(localRoot, "z.md", "local-z");
    writeFile(remoteRoot, "z.md", "remote-z");
    const r3 = await runChoice(mkConflict("z.md", "local-z", "remote-z"), "both", (p) =>
      `z.conflict-${p}`
    );
    assert.equal(r3.errors.length, 0, JSON.stringify(r3.errors));
    assert.ok(r3.copyPath, "应返回副本路径");
    assert.equal(fs.readFileSync(path.join(localRoot, "z.md"), "utf8"), "remote-z", "原文件变成电脑版本");
    assert.equal(fs.readFileSync(path.join(localRoot, r3.copyPath), "utf8"), "local-z", "副本保留本机版本");
  } finally {
    await handle.close();
  }
});

async function withSession(base, fn) {
  const start = await fetch(`${base}/api/v1/session/start`, {
    method: "POST",
    headers: { "x-lan-sync-token": TOKEN },
  });
  const { sessionId } = await start.json();
  try {
    return await fn(sessionId);
  } finally {
    await fetch(`${base}/api/v1/session/end?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "x-lan-sync-token": TOKEN, "x-lan-sync-session": sessionId },
    });
  }
}

test("端到端：本插件程序文件会同步，配对码/基线/临时文件不会", async () => {
  const remoteRoot = makeTempDir("lan-remote12-");
  const localRoot = makeTempDir("lan-local12-");
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/main.js", "console.log('v1')");
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/manifest.json", '{"id":"lan-sync"}');
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/styles.css", ".x{}");
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/data.json", '{"token":"SECRET"}');
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/baseline.json", '{"version":1}');
  writeFile(remoteRoot, ".obsidian/plugins/lan-sync/tmp/a.part", "junk");
  writeFile(remoteRoot, "note.md", "hello");

  const handle = await createSyncServer({
    port: 39311,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { plan } = await pullOnce(base, localRoot);
    const paths = plan.downloads.map((d) => d.path).sort();

    assert.ok(paths.includes(".obsidian/plugins/lan-sync/main.js"), "main.js 应同步");
    assert.ok(paths.includes(".obsidian/plugins/lan-sync/manifest.json"), "manifest 应同步");
    assert.ok(paths.includes(".obsidian/plugins/lan-sync/styles.css"), "styles.css 应同步");
    assert.ok(paths.includes("note.md"));

    for (const forbidden of ["data.json", "baseline.json", "tmp/a.part"]) {
      assert.ok(
        !paths.some((p) => p.endsWith(forbidden)),
        `${forbidden} 绝不能同步（含凭据/基线/临时文件）`
      );
    }

    assert.equal(fs.readFileSync(path.join(localRoot, ".obsidian/plugins/lan-sync/main.js"), "utf8"), "console.log('v1')");
    assert.equal(fs.existsSync(path.join(localRoot, ".obsidian/plugins/lan-sync/data.json")), false);
    assert.equal(fs.existsSync(path.join(localRoot, ".obsidian/plugins/lan-sync/baseline.json")), false);
    assert.equal(fs.existsSync(path.join(localRoot, ".obsidian/plugins/lan-sync/tmp/a.part")), false);
  } finally {
    await handle.close();
  }
});

test("端到端：带冲突标记的远端文件不会被拉到本机", async () => {
  const remoteRoot = makeTempDir("lan-remote13-");
  const localRoot = makeTempDir("lan-local13-");
  writeFile(remoteRoot, "clean.md", "正常内容");
  writeFile(remoteRoot, "dirty.md", "a\n<<<<<<<\n更新于: 20:31\n=======\n更新于: 17:43\n>>>>>>>\n");

  const handle = await createSyncServer({
    port: 39321,
    token: TOKEN,
    uploadDir: path.join(remoteRoot, ".tmp-upload"),
    vaultDir: remoteRoot,
    ignore: IGNORE,
    log: () => {},
  });

  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { plan, result } = await pullOnce(base, localRoot);
    assert.ok(plan.downloads.some((d) => d.path === "clean.md"));
    assert.ok(!plan.downloads.some((d) => d.path === "dirty.md"), "冲突文件不应被下载");
    assert.ok(plan.skipped.some((s) => s.path === "dirty.md"));
    assert.equal(result.errors.length, 0);
    assert.equal(fs.existsSync(path.join(localRoot, "dirty.md")), false);
    assert.equal(fs.readFileSync(path.join(localRoot, "clean.md"), "utf8"), "正常内容");
  } finally {
    await handle.close();
  }
});
