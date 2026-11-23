/**
 * WebDAV 传输层测试：用内存假服务器跑 PROPFIND/GET(Range)/PUT+MOVE/DELETE/COPY/锁，
 * 以及和 core 的 plan/engine 串起来的端到端拉取/推送。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../dist/core.cjs");
const { WebDavClient } = require("../dist/webdav.cjs");
const { buildManifest, planSync, applyPullPlan, applyPushPlan, emptyBaseline } = core;

const BASE = "http://fake";
const ROOT = "lansync/TestVault";

// ---------- 内存假 WebDAV 服务器 ----------
function makeFakeWebDav() {
  const files = new Map(); // "/lansync/TestVault/a.md" -> { data: Buffer, mtime: number }
  const dirs = new Set(); // "/lansync/TestVault"
  const stats = { gets: 0, puts: 0, propfinds: 0, moves: 0, copies: 0 };
  const hooks = {}; // 一次性钩子：hooks.beforeMove({abs,dest}) 在下一次 MOVE 前触发

  const norm = (p) => {
    let s = p;
    if (s.startsWith(BASE)) s = s.slice(BASE.length);
    s = s.replace(/^\/+/, "");
    s = decodePath(s);
    if (s && !s.startsWith("/")) s = "/" + s;
    return s;
  };
  const decodePath = (p) => p.split("/").map((x) => { try { return decodeURIComponent(x); } catch { return x; } }).join("/");
  const encodePath = (p) => p.split("/").map((x) => encodeURIComponent(x)).join("/");
  const parent = (p) => { const i = p.lastIndexOf("/"); return i <= 0 ? "" : p.slice(0, i); };
  const ensureParents = (p) => {
    let cur = parent(p);
    while (cur) { dirs.add(cur); cur = parent(cur); }
    dirs.add("/");
  };
  const addFile = (rel, content, mtimeMs = Date.now()) => {
    const abs = "/" + ROOT + "/" + rel.replace(/^\/+/, "");
    files.set(abs, { data: Buffer.from(content), mtime: mtimeMs });
    ensureParents(abs);
  };

  const fmtDate = (ms) => new Date(ms).toUTCString();
  const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fileResp = (abs) => {
    const f = files.get(abs);
    return `<d:response><d:href>${encodePath(abs)}</d:href><d:propstat><d:prop>` +
      `<d:resourcetype></d:resourcetype>` +
      `<d:getcontentlength>${f.data.length}</d:getcontentlength>` +
      `<d:getlastmodified>${xmlEscape(fmtDate(f.mtime))}</d:getlastmodified>` +
      `<d:getetag>"${f.data.length}-${f.mtime}"</d:getetag>` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  };
  const dirResp = (abs) =>
    `<d:response><d:href>${encodePath(abs)}/</d:href><d:propstat><d:prop>` +
    `<d:resourcetype><d:collection/></d:resourcetype>` +
    `<d:getlastmodified>${xmlEscape(fmtDate(Date.now()))}</d:getlastmodified>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  async function request({ url, method, headers = {}, body }) {
    const h = {};
    for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
    const abs = norm(url.replace(/[?#].*$/, ""));
    const dirPath = abs.replace(/\/+$/, "");

    if (method === "PROPFIND") {
      stats.propfinds++;
      if (!dirs.has(dirPath) && ![...files.keys()].some((f) => f.startsWith(dirPath + "/"))) {
        return { status: 404, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
      }
      const depth = h["depth"] || "1";
      let parts = [dirResp(dirPath)];
      if (depth !== "0") {
        for (const d of dirs) if (d !== dirPath && parent(d) === dirPath) parts.push(dirResp(d));
        for (const f of files.keys()) if (parent(f) === dirPath) parts.push(fileResp(f));
      }
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${parts.join("")}</d:multistatus>`;
      return { status: 207, headers: {}, text: xml, arrayBuffer: new ArrayBuffer(0) };
    }

    if (method === "MKCOL") {
      dirs.add(dirPath); ensureParents(dirPath);
      return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
    }

    if (method === "PUT") {
      stats.puts++;
      const buf = typeof body === "string" ? Buffer.from(body) : Buffer.from(new Uint8Array(body));
      const mt = h["x-oc-mtime"] ? Number(h["x-oc-mtime"]) * 1000 : Date.now();
      files.set(abs, { data: buf, mtime: mt });
      ensureParents(abs);
      return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
    }

    if (method === "GET") {
      stats.gets++;
      const f = files.get(abs);
      if (!f) return { status: 404, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
      const range = h["range"];
      if (range) {
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        const start = Number(m[1]); const end = Number(m[2]);
        const slice = f.data.subarray(start, end + 1);
        return { status: 206, headers: {}, text: slice.toString("utf8"), arrayBuffer: toArrayBuffer(slice) };
      }
      return { status: 200, headers: {}, text: f.data.toString("utf8"), arrayBuffer: toArrayBuffer(f.data) };
    }

    if (method === "DELETE") {
      files.delete(abs); dirs.delete(abs);
      return { status: 204, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
    }

    if (method === "MOVE" || method === "COPY") {
      if (method === "MOVE") stats.moves++; else stats.copies++;
      const dest = norm(h["destination"] || "");
      if (method === "MOVE" && hooks.beforeMove) { const fn = hooks.beforeMove; hooks.beforeMove = null; fn({ abs, dest }); }
      const overwrite = (h["overwrite"] || "T").toUpperCase();
      const exists = files.has(dest) || dirs.has(dest);
      if (exists && overwrite === "F") {
        return { status: 412, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
      }
      const f = files.get(abs);
      if (!f) return { status: 404, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
      const mt = h["x-oc-mtime"] ? Number(h["x-oc-mtime"]) * 1000 : f.mtime;
      files.set(dest, { data: f.data, mtime: mt });
      ensureParents(dest);
      if (method === "MOVE") files.delete(abs);
      return { status: 201, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
    }

    return { status: 405, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
  }

  return {
    http: { request },
    files, dirs, stats, hooks, addFile,
    read(rel) {
      const f = files.get("/" + ROOT + "/" + rel);
      return f ? f.data : null;
    },
  };
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function newClient(server, cache, deviceId = "dev-test") {
  return new WebDavClient(server.http, {
    baseUrl: BASE,
    root: ROOT,
    user: "u",
    pass: "p",
    deviceId,
    deviceName: "电脑",
    ignore: { configDir: ".obsidian", selfPluginId: "lan-sync" },
    chunkBytes: 64 * 1024,
    maxHashBytes: 1024 * 1024,
    retryBaseMs: 1,
    maxRetries: 0,
  }, cache);
}

// ---------- 清单 / 缓存 ----------
test("WebDAV：递归清单、忽略规则、内容哈希", async () => {
  const s = makeFakeWebDav();
  s.addFile("a.md", "hello");
  s.addFile("dir/b.md", "world");
  s.addFile(".git/config", "x");
  s.addFile(".obsidian/plugins/lan-sync/data.json", "secret");
  const client = newClient(s);
  const manifest = await client.fetchManifest();
  const paths = manifest.entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ["a.md", "dir/b.md"]);
  const a = manifest.entries.find((e) => e.path === "a.md");
  assert.equal(a.sha256, sha256(Buffer.from("hello")));
});

test("WebDAV：ETag 未变时不重复下载（哈希缓存生效）", async () => {
  const s = makeFakeWebDav();
  s.addFile("a.md", "hello");
  s.addFile("b.md", "world");
  const cache = new Map();
  const client = newClient(s, cache);
  await client.fetchManifest();
  const getsAfterFirst = s.stats.gets;
  assert.equal(getsAfterFirst, 2, "首次应下载两个文件算哈希");
  await client.fetchManifest();
  assert.equal(s.stats.gets, getsAfterFirst, "第二次不应再下载（ETag 未变）");
});

// ---------- 传输 ----------
test("WebDAV：Range 下载、PUT+MOVE 上传、删除、备份", async () => {
  const s = makeFakeWebDav();
  const client = newClient(s);
  const big = Buffer.alloc(200 * 1024, 7);
  s.addFile("big.bin", big);

  const chunks = [];
  const res = await client.downloadFile("big.bin", big.length, async (m) => { chunks.push(Buffer.from(m.chunk)); });
  assert.equal(res.bytes, big.length);
  assert.equal(Buffer.concat(chunks).length, big.length);
  assert.equal(Buffer.concat(chunks).equals(big), true, "Range 分块拼接应与原文一致");

  await client.putFile("new/x.md", toArrayBuffer(Buffer.from("abc")), null, Date.now());
  assert.equal(s.read("new/x.md").toString(), "abc", "PUT+MOVE 后内容应正确");

  await client.backupFiles(["new/x.md"], ".trash/bk");
  assert.ok(s.read(".trash/bk/new/x.md"), "备份应 COPY 到 .trash");

  await client.deleteRemote("new/x.md");
  assert.equal(s.read("new/x.md"), null, "删除后应不存在");
});

// ---------- 锁 ----------
test("WebDAV：锁文件跨客户端互斥 + 释放后可获取", async () => {
  const s = makeFakeWebDav();
  const a = newClient(s, undefined, "device-A");
  const b = newClient(s, undefined, "device-B");
  await a.acquireLock(60000);
  const resB = await b.acquireLock(60000);
  assert.equal(resB.acquired, false, "第二个客户端不应拿到锁");
  await a.releaseLock();
  const resB2 = await b.acquireLock(60000);
  assert.equal(resB2.acquired, true, "释放后应能拿到锁");
  await b.releaseLock();
});

test("WebDAV：抢锁竞态（MOVE 前被抢先）不覆盖他人锁", async () => {
  const s = makeFakeWebDav();
  const b = newClient(s, undefined, "device-B");
  const lockAbs = "/" + ROOT + "/.lansync/lock.json";
  // 在 B 的 MOVE 真正执行前，让 A 的未过期锁“突然出现”（模拟 readLock 后、MOVE 前的竞态）
  s.hooks.beforeMove = () => {
    s.files.set(lockAbs, {
      data: Buffer.from(JSON.stringify({ deviceId: "device-A", device: "电脑A", startedAt: Date.now(), expiresAt: Date.now() + 60000 })),
      mtime: Date.now(),
    });
    s.dirs.add("/" + ROOT + "/.lansync");
  };
  const res = await b.acquireLock(60000);
  assert.equal(res.acquired, false, "他人已持锁，B 不应抢到");
  const lock = JSON.parse(s.files.get(lockAbs).data.toString("utf8"));
  assert.equal(lock.deviceId, "device-A", "他人锁不应被覆盖（必须用 Overwrite:F）");
});

test("WebDAV：过期锁可被接管", async () => {
  const s = makeFakeWebDav();
  const b = newClient(s, undefined, "device-B");
  s.addFile(".lansync/lock.json", JSON.stringify({
    deviceId: "device-A", device: "电脑A", startedAt: Date.now() - 120000, expiresAt: Date.now() - 60000,
  }));
  const res = await b.acquireLock(60000);
  assert.equal(res.acquired, true, "过期锁应可接管");
  const lock = JSON.parse(s.read(".lansync/lock.json").toString("utf8"));
  assert.equal(lock.deviceId, "device-B", "接管后锁应属于 B");
  await b.releaseLock();
});

// ---------- 端到端：plan/engine + WebDAV ----------
function makeNodeAdapter(root) {
  const abs = (p) => path.join(root, p.replace(/\//g, path.sep));
  return {
    async exists(p) { return fs.existsSync(abs(p)); },
    async stat(p) {
      try {
        const st = fs.statSync(abs(p));
        return { type: st.isDirectory() ? "folder" : "file", size: st.size, mtime: Math.trunc(st.mtimeMs), ctime: Math.trunc(st.ctimeMs) };
      } catch { return null; }
    },
    async list(p) {
      const dir = abs(p); const out = { files: [], folders: [] };
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
      for (const ent of entries) {
        const rel = p ? `${p}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.folders.push(rel); else out.files.push(rel);
      }
      return out;
    },
    async readBinary(p) { const b = fs.readFileSync(abs(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async writeBinary(p, data) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), Buffer.from(data)); },
    async appendBinary(p, data) { fs.appendFileSync(abs(p), Buffer.from(data)); },
    async mkdir(p) { fs.mkdirSync(abs(p), { recursive: true }); },
    async remove(p) { fs.rmSync(abs(p), { force: true, recursive: true }); },
    async rename(from, to) { fs.mkdirSync(path.dirname(abs(to)), { recursive: true }); fs.renameSync(abs(from), abs(to)); },
  };
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "wd-")); }

test("端到端：WebDAV 拉取（远端新文件落到本机）", async () => {
  const s = makeFakeWebDav();
  s.addFile("note/a.md", "# hi");
  const client = newClient(s);
  const local = makeNodeAdapter(tmpdir());
  const remoteManifest = await client.fetchManifest();
  const plan = planSync([], remoteManifest.entries, emptyBaseline(), { mode: "both" });
  assert.equal(plan.downloads.length, 1);
  const pull = await applyPullPlan(local, client, plan, emptyBaseline(), { tmpDir: ".obsidian/plugins/lan-sync/tmp", remoteEntries: remoteManifest.entries });
  assert.equal(pull.errors.length, 0);
  assert.equal((await local.readBinary("note/a.md")).byteLength, 4);
});

test("端到端：WebDAV 推送（本机新文件上传到远端，整文件 PUT）", async () => {
  const s = makeFakeWebDav();
  const client = newClient(s);
  const root = tmpdir();
  fs.mkdirSync(path.join(root, "note"), { recursive: true });
  fs.writeFileSync(path.join(root, "note/a.md"), "push me");
  const local = makeNodeAdapter(root);
  const localManifest = await buildManifest(local, { ignore: { configDir: ".obsidian", selfPluginId: "lan-sync" } });
  const plan = planSync(localManifest.entries, [], emptyBaseline(), { mode: "both" });
  assert.equal(plan.uploads.length, 1);
  const push = await applyPushPlan(local, client, plan, emptyBaseline(), { remoteEntries: [] });
  assert.equal(push.errors.length, 0);
  assert.equal(s.read("note/a.md").toString(), "push me");
});

test("计划层：一端删、另一端改 → 编辑优先重建（不丢改动）", () => {
  // 远端删除、本机改过 → 应上传重建，而不是删除本机
  const base = { version: 1, updatedAt: 1, entries: { "a.md": { size: 2, sha256: "v1" } } };
  const plan = planSync([{ path: "a.md", size: 3, sha256: "v2", mtime: 1 }], [], base, { mode: "both" });
  assert.deepEqual(plan.deleteLocal, []);
  assert.deepEqual(plan.uploads.map((u) => u.path), ["a.md"]);
  assert.ok(plan.editWins.includes("a.md"));

  // 本机删除、远端改过 → 应下载恢复，而不是删远端
  const plan2 = planSync([], [{ path: "b.md", size: 3, sha256: "v2", mtime: 1 }], { version: 1, updatedAt: 1, entries: { "b.md": { size: 2, sha256: "v1" } } }, { mode: "both" });
  assert.deepEqual(plan2.deleteRemote, []);
  assert.deepEqual(plan2.downloads.map((d) => d.path), ["b.md"]);
  assert.ok(plan2.editWins.includes("b.md"));

  // 一端删、另一端未改 → 正常传播删除
  const plan3 = planSync([], [{ path: "c.md", size: 2, sha256: "v1", mtime: 1 }], { version: 1, updatedAt: 1, entries: { "c.md": { size: 2, sha256: "v1" } } }, { mode: "both" });
  assert.deepEqual(plan3.deleteRemote, ["c.md"]);
});

test("WebDAV：startSession 建立同步根并加锁 / 释放", async () => {
  const s = makeFakeWebDav();
  const a = newClient(s, undefined, "dev-A");
  const b = newClient(s, undefined, "dev-B");
  await a.startSession(60000);
  assert.ok(s.dirs.has("/" + ROOT), "应创建同步根目录（且不重复拼 root）");
  await assert.rejects(() => b.startSession(60000), /正在同步/);
  await a.endSession();
  await b.startSession(60000);
  await b.endSession();
});
