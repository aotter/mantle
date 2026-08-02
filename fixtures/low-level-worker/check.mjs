import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const port = await freePort();
const logs = [];
const wrangler = spawn(
  "wrangler",
  ["dev", "--port", String(port), "--inspector-port", "0"],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let spawnError;
wrangler.once("error", (error) => { spawnError = error; });
wrangler.stdout.on("data", (chunk) => logs.push(String(chunk)));
wrangler.stderr.on("data", (chunk) => logs.push(String(chunk)));

try {
  const base = `http://127.0.0.1:${port}`;
  await waitUntilReady(`${base}/cache-probe`);

  const custom = await timedFetch(`${base}/api/custom-audit`, { method: "POST" });
  assert.equal(custom.status, 200);
  assert.deepEqual(await custom.json(), { ok: true, queued: true });

  const view = await timedFetch(`${base}/api/views/published-notes`);
  assert.equal(view.status, 200);
  assert.deepEqual((await view.json()).data?.rows, []);

  const asset = await timedFetch(base);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /Mantle low-level Worker/);

  const standard = await timedFetch(`${base}/api/auth/get-session`);
  assert.equal(standard.status, 503);
  assert.equal(standard.headers.get("cache-control"), "private, no-store");

  const admin = await timedFetch(`${base}/admin`);
  assert.equal(admin.status, 503);
  assert.equal(admin.headers.get("cache-control"), "private, no-store");

  const publicResponse = await timedFetch(`${base}/cache-probe`);
  assert.equal(publicResponse.headers.get("cache-control"), "public, s-maxage=60");
  assert.equal(publicResponse.headers.get("vary"), "Cookie, Authorization");

  const credentialed = await timedFetch(`${base}/cache-probe`, {
    headers: { authorization: "Bearer token" },
  });
  assert.equal(credentialed.headers.get("cache-control"), "private, no-store");
} finally {
  await stopWorker(wrangler);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitUntilReady(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (wrangler.exitCode !== null) break;
    try {
      const response = await timedFetch(url, {}, 750);
      if (response.status > 0) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Wrangler did not start:\n${logs.join("")}`);
}

function timedFetch(input, init = {}, timeout = 10_000) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeout),
  });
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  signalProcessGroup(child, "SIGTERM");
  if (await exitsWithin(child, 3_000)) return;
  signalProcessGroup(child, "SIGKILL");
  if (!(await exitsWithin(child, 2_000))) {
    throw new Error(`Wrangler process ${child.pid} did not stop`);
  }
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function exitsWithin(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
