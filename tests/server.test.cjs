const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSyncServer } = require("../dist/server.cjs");

const TOKEN = "123456";
const PORT = 39123;
const AUTH = { "x-lan-sync-token": TOKEN };

let handle;
let base;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const patternByte = (i) => (i * 31 + 7) & 0xff;

test.before(async () => {
  handle = await createSyncServer({
    port: PORT,
    token: TOKEN,
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-test-")),
    pluginDir: path.resolve(__dirname, ".."),
    vaultDir: fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-vault-")),
    log: () => {},
  });
  base = `http://127.0.0.1:${handle.port}`;
});

test.after(async () => {
  await handle.close();
});

test("ping 不需要鉴权，返回服务信息", async () => {
  const resp = await fetch(`${base}/api/ping`);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.equal(body.app, "lan-sync");
  assert.equal(resp.headers.get("access-control-allow-origin"), "*");
});

test("令牌错误返回 401", async () => {
  const resp = await fetch(`${base}/api/blob?mb=1`, {
    headers: { "x-lan-sync-token": "000000" },
  });
  assert.equal(resp.status, 401);
  const body = await resp.json();
  assert.equal(body.ok, false);
});

test("OPTIONS 预检返回 204 和 CORS 头", async () => {
  const resp = await fetch(`${base}/api/ping`, { method: "OPTIONS" });
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get("access-control-allow-origin"), "*");
  assert.ok(resp.headers.get("access-control-allow-headers"));
});

test("blob 指定 offset/len 返回正确切片与哈希", async () => {
  const offset = 1024 * 1024 + 12345;
  const len = 700000;
  const resp = await fetch(`${base}/api/blob?mb=2&offset=${offset}&len=${len}`, { headers: AUTH });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get("x-total-bytes"), String(2 * 1024 * 1024));
  const buf = Buffer.from(await resp.arrayBuffer());
  assert.equal(buf.length, len);
  assert.equal(resp.headers.get("x-chunk-sha256"), sha256(buf));
  for (const i of [0, 1, 1000, len - 1]) {
    assert.equal(buf[i], patternByte(offset + i), `偏移 ${offset + i} 的字节不符合确定性模式`);
  }
});

test("blob 不传 len 时返回到末尾", async () => {
  const offset = 1024 * 1024 - 100;
  const resp = await fetch(`${base}/api/blob?mb=1&offset=${offset}`, { headers: AUTH });
  const buf = Buffer.from(await resp.arrayBuffer());
  assert.equal(buf.length, 100);
});

test("echo 返回请求体长度与哈希", async () => {
  const payload = Buffer.from("局域网同步 spike 测试 payload");
  const resp = await fetch(`${base}/api/echo`, { method: "POST", headers: AUTH, body: payload });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.received, payload.length);
  assert.equal(body.sha256, sha256(payload));
});

test("分块上传后服务端哈希一致", async () => {
  const total = 3 * 1024 * 1024 + 123;
  const payload = Buffer.allocUnsafe(total);
  for (let i = 0; i < total; i++) payload[i] = (i * 17 + 3) & 0xff;

  const initResp = await fetch(`${base}/api/upload/init`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ name: "chunk-test.bin", size: total }),
  });
  const init = await initResp.json();
  assert.equal(init.ok, true);
  assert.ok(init.uploadId);

  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < total; offset += chunkSize) {
    const part = payload.subarray(offset, Math.min(offset + chunkSize, total));
    const resp = await fetch(
      `${base}/api/upload/chunk?uploadId=${init.uploadId}&offset=${offset}`,
      { method: "POST", headers: AUTH, body: part }
    );
    assert.equal(resp.status, 200);
  }

  const finResp = await fetch(`${base}/api/upload/finish?uploadId=${init.uploadId}`, {
    method: "POST",
    headers: AUTH,
  });
  const result = await finResp.json();
  assert.equal(result.size, total);
  assert.equal(result.sha256, sha256(payload));
  assert.equal(result.received, total);
});

test("端口被占用时自动顺延", async () => {
  const second = await createSyncServer({
    port: PORT,
    token: TOKEN,
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), "lan-sync-test2-")),
    log: () => {},
  });
  try {
    assert.notEqual(second.port, PORT);
    const resp = await fetch(`http://127.0.0.1:${second.port}/api/ping`);
    assert.equal(resp.status, 200);
  } finally {
    await second.close();
  }
});

test("未知接口返回 404 JSON", async () => {
  const resp = await fetch(`${base}/api/nope`, { headers: AUTH });
  assert.equal(resp.status, 404);
  const body = await resp.json();
  assert.equal(body.ok, false);
});

test("手机安装页可直接打开", async () => {
  const resp = await fetch(`${base}/?token=${TOKEN}`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") || "", /text\/html/);
  const html = await resp.text();
  assert.match(html, /LAN Sync/);
  assert.match(html, /main\.js/);
});

test("安装文件下载需要配对码且内容正确", async () => {
  const ok = await fetch(`${base}/install/file?name=manifest.json&token=${TOKEN}`);
  assert.equal(ok.status, 200);
  const manifest = await ok.json();
  assert.equal(manifest.id, "lan-sync");

  const denied = await fetch(`${base}/install/file?name=manifest.json&token=000000`);
  assert.equal(denied.status, 401);

  const traversal = await fetch(`${base}/install/file?name=../package.json&token=${TOKEN}`);
  assert.equal(traversal.status, 404);
});

test("v1 同步会话：同一时刻只允许一个客户端", async () => {
  const first = await fetch(`${base}/api/v1/session/start`, { method: "POST", headers: AUTH });
  assert.equal(first.status, 200);
  const { sessionId } = await first.json();
  assert.ok(sessionId);

  const second = await fetch(`${base}/api/v1/session/start`, { method: "POST", headers: AUTH });
  assert.equal(second.status, 409, "第二个会话应被拒绝");
  const secondBody = await second.json();
  assert.match(secondBody.error, /另一台设备/);

  const noSession = await fetch(`${base}/api/v1/manifest`, { headers: AUTH });
  assert.equal(noSession.status, 409, "无会话请求清单应被拒绝");

  const ok = await fetch(`${base}/api/v1/manifest`, {
    headers: { ...AUTH, "x-lan-sync-session": sessionId },
  });
  assert.equal(ok.status, 200);
  const manifest = await ok.json();
  assert.ok(Array.isArray(manifest.entries));

  const end = await fetch(`${base}/api/v1/session/end?sessionId=${sessionId}`, {
    method: "POST",
    headers: AUTH,
  });
  assert.equal(end.status, 200);

  const third = await fetch(`${base}/api/v1/session/start`, { method: "POST", headers: AUTH });
  assert.equal(third.status, 200, "结束后应能重新建立会话");
  const thirdBody = await third.json();
  await fetch(`${base}/api/v1/session/end?sessionId=${thirdBody.sessionId}`, {
    method: "POST",
    headers: AUTH,
  });
});

test("一次性下载 zip 且能解出三个文件", async () => {
  const resp = await fetch(`${base}/install/all.zip?token=${TOKEN}`);
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type") || "", /application\/zip/);
  const buf = Buffer.from(await resp.arrayBuffer());
  assert.ok(buf.length > 1000, "zip 内容不能是空的");
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "应以 PK\\x03\\x04 开头");

  // 解析中央目录，确认三个文件都在
  const endIndex = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endIndex > 0, "应有 EOCD");
  const count = buf.readUInt16LE(endIndex + 10);
  assert.equal(count, 4, "应包含 main.js / manifest.json / styles.css / 安装说明.txt");

  const text = buf.toString("utf8");
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    assert.ok(text.includes(name), `zip 里应含 ${name}`);
  }

  const denied = await fetch(`${base}/install/all.zip?token=000000`);
  assert.equal(denied.status, 401);
});
