import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, webcrypto } from "node:crypto";
import { benchmarkHttpRoutes } from "../packages/mantle-runtime/dist/testing.js";

const root = resolve(import.meta.dirname, "..");
const remote = process.env.BENCH_ORIGIN;
const key = process.env.BENCHMARK_KEY ?? (remote ? (() => { throw new Error("BENCHMARK_KEY required"); })() : randomUUID() + randomUUID());
const persistence = await mkdtemp(join(tmpdir(), "mantle-parity-"));
const port = await availablePort(), inspectorPort = await availablePort();
const origin = remote ?? `http://127.0.0.1:${port}`;
const config = join(root, "packages/adapters/cloudflare/test/performance/wrangler-parity.jsonc");
const rounds = Math.max(10, Math.min(200, Number(process.env.BENCH_ROUNDS) || 30));
const startedAt = new Date().toISOString();
const fixtureLocales = (process.env.BENCH_LOCALES ?? "en").split(",");
const itemLocale = fixtureLocales[1 % fixtureLocales.length];
const results = [], assertions = [], logs = [];
const packageRequire = createRequire(new URL("../packages/adapters/cloudflare/package.json", import.meta.url));
const versions = {
  node: process.version,
  sdkVersion: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  sdkCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sdkDirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  wrangler: packageRequire("wrangler/package.json").version,
  compatibilityDate: "2026-07-08",
  deploymentBlock: process.env.BENCH_BLOCK ?? null,
  configuredPlacement: process.env.BENCH_PLACEMENT ?? null,
};
let child, cdp, credentials, dpopCredentials, currentBoot, remoteTail, bundle = null;
const dpopKey = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", dpopKey.publicKey);

try {
  if (remote) remoteTail = await connectRemoteTail();
  if (!remote) {
    const output = execFileSync("pnpm", ["--filter", "@aotter/mantle-cloudflare", "exec", "wrangler", "deploy", "--dry-run", "--config", config,
      "--outdir", join(persistence, "bundle")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const size = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(output);
    assert(size, "Wrangler reports upload size");
    bundle = { source: "Wrangler dry-run upload", rawKiB: Number(size[1]), gzipKiB: Number(size[2]) };
    await start();
  }
  currentBoot = await health();
  if (bundle && currentBoot.routes === 1 && currentBoot.schemas === 1 && currentBoot.views === 1) {
    assert(bundle.rawKiB <= 4500 && bundle.gzipKiB <= 800, "default fixture bundle <= 4,500 KiB raw / 800 KiB gzip");
  }
  await measure(remote ? "deployment-first-health" : "empty-health", "/health", { rounds: 1, warmup: 0 });
  await measure(remote ? "deployment-first-auth-ready" : "empty-setup", "/.well-known/oauth-authorization-server/api/auth", { rounds: 1, warmup: 0 });
  await control("seed", { rows: 100, bytes: 64 });
  credentials = await control("login", {});
  dpopCredentials = await control("login", { proof: await proof("POST", `${origin}/api/auth/oauth2/token`) });
  assertions.push("real Better Auth PKCE + OTP + consent + JWT + DPoP token issuance");

  if (process.env.BENCH_CASES === "scaling") {
    const routeCount = currentBoot.routes, viewCount = currentBoot.views;
    for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2", "F1"] : ["F1", "F2", "M"])) {
      const view = await measure(`scale-view-${viewCount}-${layer}`, `/api/views/items-${viewCount - 1}`, { layer, rounds: 100 });
      assertNativeBudget(view.records, 1, "scaled View");
      const procedure = await measure(`scale-trigger-${routeCount}-${layer}`, `/api/lookup-${String(routeCount - 1).padStart(4, "0")}`, { layer, json: { id: "item-1" }, rounds: 100 });
      assertNativeBudget(procedure.records, 1, "scaled Procedure");
    }
    await measure("scale-catalog", "/api/views", { rounds: 20 });
    for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) await measure(`scale-mcp-catalog-${layer}`, "/mcp", { layer, token: true, json: { jsonrpc: "2.0", id: 1, method: "tools/list" }, rounds: 30 });
    assertions.push("route/schema/view scale: last route and View keep one native statement");
  } else {
  for (const layer of ["F0", "F1", "F2", "M"]) await measure(`health-${layer}`, "/health", { layer, expected: "ok" });
  for (const path of ["/api/views", "/admin/sign-in", "/admin/api/entries?collection=items&limit=20", `/${itemLocale}/items/item-1`, "/en/items", "/llms.txt", "/sitemap.xml"]) {
    await measure(`surface-${path}`, path, { cookie: path.includes("/admin/api") });
  }
  for (const bytes of [64, 4096]) for (const rows of [100, 10_000, 50_000]) {
    if (process.env.BENCH_QUICK === "1" && (bytes !== 64 || rows !== 100)) continue;
    await control("seed", { rows, bytes });
    let expected;
    for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2", "F1"] : ["F1", "F2", "M"])) {
      const measured = await measure(`view-${rows}-${bytes}-${layer}`, "/api/views/items-0", { layer });
      const body = JSON.parse(measured.bodies[0]);
      expected ??= body;
      assert.deepEqual(body, expected, `${layer} public View result`);
      assert.equal(body.data.rows.length, 20);
      assert(body.data.rows.every((row) => Number(row.id.slice(5)) % 5 !== 0), "draft privacy");
      assertNativeBudget(measured.records, 1, "indexed View");
      assert(measured.records.every(({ record }) => record.d1.rowsRead <= 100), "indexed native rows budget");
    }
    for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2", "F1"] : ["F1", "F2", "M"])) await measure(`procedure-${rows}-${bytes}-${layer}`, "/api/lookup-0000", {
      layer, json: { id: "item-1" }, expected: { ok: true, data: { entry: { id: "item-1", data: JSON.stringify({ slug: "item-1", locale: (process.env.BENCH_LOCALES ?? "en").split(",")[1 % (process.env.BENCH_LOCALES ?? "en").split(",").length], title: "Item 1", body: "x".repeat(bytes) }) } } },
    });
    for (const path of ["/en/items", "/llms.txt", "/sitemap.xml"]) {
      const page = await measure(`bounded-web-${rows}-${bytes}-${path}`, path, { rounds: 3, warmup: 1 });
      if (path !== "/sitemap.xml") assert(page.records.every(({ record }) => record.d1.statements <= 2 && record.d1.resultBytes < 1024 * 1024));
    }
  }
  // Real auth controls share the same issuer, D1, catalog KV, validation and
  // protocol package. An auth-free F0/F1 is never called MCP parity.
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  let catalog;
  for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) {
    const sample = await measure(`mcp-catalog-${layer}`, "/mcp", { layer, token: true, json: rpc });
    catalog ??= JSON.parse(sample.bodies[0]);
    assert.deepEqual(JSON.parse(sample.bodies[0]), catalog);
    assertNativeBudget(sample.records, 2, "MCP catalog");
    assert(sample.records.every(({ record }) => record.rpcOutcome === "result" && record.kv.get.calls <= 1));
  }
  const viewTool = catalog.result.tools.find((tool) => tool.name.includes("items-0") || tool.name.includes("items_0"));
  assert(viewTool, "public View tool exists");
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: viewTool.name, arguments: {} } };
  for (const authMode of ["bearer", "dpop"]) for (const concurrency of [1, 4, 8]) {
    let expected;
    for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) {
      const sample = await measure(`mcp-view-${authMode}-c${concurrency}-${layer}`, "/mcp", { layer, token: true, dpop: authMode === "dpop", json: call, concurrency });
      expected ??= JSON.parse(sample.bodies[0]);
      assert.deepEqual(JSON.parse(sample.bodies[0]), expected);
      assertNativeBudget(sample.records, authMode === "dpop" ? 4 : 3, `MCP View ${authMode}`);
      assert(sample.records.every(({ record }) => record.rpcOutcome === "result"));
    }
  }
  for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) {
    await measure(`mcp-missing-${layer}`, "/mcp", { layer, json: rpc, status: 401, rounds: 3 });
    await measure(`mcp-invalid-${layer}`, "/mcp", { layer, token: "invalid", json: rpc, status: 401, rounds: 3 });
    await measure(`mcp-no-dpop-proof-${layer}`, "/mcp", { layer, token: dpopCredentials.accessToken, json: rpc, status: 401, rounds: 3 });
    const invalid = await measure(`mcp-invalid-params-${layer}`, "/mcp", { layer, token: true, json: { ...call, params: { ...call.params, arguments: { unexpected: true } } }, rounds: 3 });
    assert(invalid.records.every(({ record }) => record.rpcOutcome === "error"));
  }
  await control("role", { userId: credentials.userId, role: "user" });
  for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) await measure(`mcp-nonstaff-${layer}`, "/mcp/staff", { layer, token: true, json: rpc, status: 403, rounds: 3 });
  await control("role", { userId: credentials.userId, role: "owner" });
  await control("consent", { consentId: credentials.consentId, scopes: "[]" });
  for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) await measure(`mcp-revoked-consent-${layer}`, "/mcp", { layer, token: true, json: rpc, status: 401, rounds: 3 });
  await control("consent", { consentId: credentials.consentId, scopes: '["mcp","offline_access"]' });
  await control("session", { sessionId: credentials.sessionId, expiresAt: new Date(0).toISOString() });
  for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) await measure(`mcp-expired-session-${layer}`, "/mcp", { layer, token: true, json: rpc, status: 401, rounds: 3 });
  await control("session", { sessionId: credentials.sessionId, expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  const replay = await proof("POST", `${origin}/mcp`, dpopCredentials.accessToken);
  await measure("dpop-first", "/mcp", { layer: "M", token: dpopCredentials.accessToken, proof: replay, json: rpc, rounds: 1, warmup: 0 });
  await measure("dpop-replay", "/mcp", { layer: "F2", token: dpopCredentials.accessToken, proof: replay, json: rpc, status: 401, rounds: 1, warmup: 0 });
  assertions.push("identical View/catalog results; drafts excluded; invalid/missing token, input, DPoP proof/replay, current role, consent and session denials");

  if (process.env.BENCH_SKIP_R2 !== "1") {
  for (const bytes of [1024, 65536, 262144]) {
    await control("r2seed", { bytes });
    for (const variants of [1, 3, 12]) {
      let expected;
      for (const layer of ["F0", "F1", "F2", "M"]) {
        const sample = await measure(`r2-${variants}-${bytes}-${layer}`, `/r2?variants=${variants}`, { layer, rounds: 10, warmup: 1 });
        if (layer === "F0") {
          assert(sample.records.every(({ record }) => record.r2.head.calls === variants && record.r2.get.calls === 0));
        } else {
          expected ??= JSON.parse(sample.bodies[0]);
          assert.deepEqual(JSON.parse(sample.bodies[0]), expected);
          assert(sample.records.every(({ record }) => record.r2.get.calls === variants && record.r2.put.calls === variants
            && record.r2.get.bytes === bytes * variants && record.r2.put.bytes === bytes * variants && record.r2.get.maxInFlight <= 3 && record.r2.put.maxInFlight <= 3));
        }
      }
    }
  }
  const failed = await measure("r2-invalid-first-batch", "/r2?variants=12&failure=1", { status: 409, rounds: 1, warmup: 0 });
  assert.equal(failed.records[0].record.r2.get.calls, 3);
  await measure("r2-retry", "/r2?variants=12", { rounds: 1, warmup: 0 });
  assertions.push("native R2 HEAD and GET/PUT floors; 1/3/12 variants and three sizes; bounded transfers; failed batch stops and retry succeeds");
  }

  for (const observed of [false, true]) for (const layer of (process.env.BENCH_ORDER === "reverse" ? ["M", "F2"] : ["F2", "M"])) await measure(`instrumentation-${observed}-${layer}`, "/mcp", { layer, token: true, json: call, observed, rounds: 100 });
  if (!remote && process.env.BENCH_QUICK !== "1") {
    let previous = currentBoot.bootId;
    for (const path of ["/health", "/api/views", "/mcp", `/${itemLocale}/items/item-1`, "/en/items"]) {
      await stop(); await start(); currentBoot = await health();
      assert.notEqual(currentBoot.bootId, previous); previous = currentBoot.bootId;
      await measure(`new-isolate-${path}`, path, { rounds: 1, warmup: 0, ...(path === "/mcp" ? { token: true, json: call } : {}) });
    }
    assertions.push("new workerd processes preserve seeded D1/KV/R2 and issued credentials");
  }
  }
  const cacheProbes = remote ? await probeCache() : null;
  const report = { version: 1, skipped: process.env.BENCH_SKIP_R2 === "1" ? ["R2: unavailable in this deployment; use the native workerd R2 matrix"] : [], cacheProbes, bundle, environment: remote ? "remote-origin" : "workerd-local", startedAt, endedAt: new Date().toISOString(),
    versions, scale: { routes: currentBoot.routes, schemas: currentBoot.schemas, views: currentBoot.views, locales: (process.env.BENCH_LOCALES ?? "en").split(",").length }, compatibilityDate: "2026-07-08", rounds, origin, assertions, results,
    notes: ["F0 health is a response floor; R2 F0 is HEAD only. F1 omits authentication. Only F2 vs M MCP/View comparisons claim matched security work.",
      "Procedure native validation errors compare status/code, not complete diagnostic text. Web/Admin are facade coverage, not matched native parity. R2 compares storage commit, not D1 MediaAsset publication.",
      "Per-request CPU is unavailable locally; inspector batch profiles separately estimate active JS samples, not billing CPU. D1 metadata coverage and pending I/O remain explicit.",
      "Generated plan is prepared outside workerd. All layers share the same synthetic bundle, data and settings; deployed consumer bundle/startup is measured separately.",
      "HTTP timing includes outer test selection; observed/off compares both binding wrappers and record overhead. No local response is labeled entrypoint cache HIT."] };
  const output = process.env.BENCH_OUTPUT ?? join(tmpdir(), `mantle-parity-${Date.now()}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ output, samples: results.reduce((n, r) => n + r.samples.length, 0), cases: results.length, assertions }) + "\n");
} catch (error) {
  await writeFile(process.env.BENCH_OUTPUT ?? join(tmpdir(), "mantle-parity-partial.json"), JSON.stringify({ partial: true, results }, null, 2));
  process.stderr.write(`${error.stack ?? error}\n`);
  // Never print auth response bodies, credentials, or the wrangler --var value.
  if (logs.length) process.stderr.write(logs.join("").replaceAll(key, "[redacted]").slice(-8000));
  process.exitCode = 1;
} finally { await stop(); await remoteTail?.close(); await rm(persistence, { recursive: true, force: true }); }

async function measure(name, path, options = {}) {
  const ids = [], bodies = [], samples = [];
  const layer = options.layer ?? "M", observed = options.observed !== false;
  if (cdp) await cdp.call("Profiler.start");
  const report = await benchmarkHttpRoutes({ rounds: options.rounds ?? rounds, warmup: options.warmup ?? 2, concurrency: options.concurrency ?? 1,
    targets: [{ name, url: `${origin}${path}`, expectedStatus: options.status ?? 200, init: async () => {
      const id = randomUUID(); ids.push(id);
      const headers = { "x-benchmark-key": key, "x-benchmark-layer": layer, "x-benchmark-request": id,
        "x-benchmark-case": name, "x-benchmark-observe": observed ? "on" : "off", "mcp-protocol-version": "2025-11-25" };
      if (remote) headers.cookie = "__benchmark_origin=1"; // Force facade private/no-store for origin timing.
      if (options.cookie) headers.cookie = credentials.cookie;
      if (options.token) {
        const token = options.token === true ? (options.dpop ? dpopCredentials : credentials).accessToken : options.token;
        headers.authorization = `${options.dpop || options.proof ? "DPoP" : "Bearer"} ${token}`;
        if (options.dpop || options.proof) headers.dpop = options.proof ?? await proof("POST", `${origin}${path}`, token);
      }
      if (options.json !== undefined) headers["content-type"] = "application/json";
      return { method: options.json === undefined && path !== "/r2" && !path.startsWith("/r2?") ? "GET" : "POST", headers, ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }) };
    }, validate(response, buffer) {
      const text = new TextDecoder().decode(buffer); bodies.push(text);
      if (options.expected !== undefined) assert.deepEqual(typeof options.expected === "string" ? text : JSON.parse(text), options.expected, name);
      if (path.startsWith("/mcp") || path.startsWith("/admin")) assert.match(response.headers.get("cache-control"), /private.*no-store/);
      assert(buffer.byteLength <= 2 * 1024 * 1024, `${name} bounded response`);
    } }], onSample(sample) { samples.push(sample); },
  });
  let cpuProfile = null, heap = null;
  if (cdp) {
    const { profile } = await cdp.call("Profiler.stop");
    const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
    const sums = { activeMs: 0, idleMs: 0, programMs: 0, gcMs: 0 };
    for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
      const name = names.get(profile.samples[i]);
      const ms = (profile.timeDeltas?.[i] ?? 0) / 1000;
      if (name === "(idle)") sums.idleMs += ms;
      else { sums.activeMs += ms; if (name === "(program)") sums.programMs += ms; if (name === "(garbage collector)") sums.gcMs += ms; }
    }
    cpuProfile = { source: "CDP statistical batch profile", samplingIntervalUs: 100, sampleCount: profile.samples?.length ?? 0,
      includesWarmup: options.warmup ?? 2, ...sums, activeMsPerRequest: sums.activeMs / ids.length };
    const afterBatch = await cdp.call("Runtime.getHeapUsage");
    heap = { source: "inspector snapshot after batch; not instantaneous peak or retained-after-GC heap", afterBatch };
    assert(afterBatch.usedSize <= 96 * 1024 * 1024, `${name} observed JS heap <= 96 MiB`);
  }
  const observations = remote ? await remoteRecords(ids) : observed ? await control("records", ids) : [];
  if (observed) assert(observations.length === ids.length && observations.every((value) => value?.record), `${name} every request has an independent diagnostic record`);
  const warmup = options.warmup ?? 2;
  const measuredRecords = observed ? observations.slice(warmup) : [];
  assert(measuredRecords.every(({ record }) => record.simultaneousArrivals >= 1 && record.simultaneousArrivals <= (options.concurrency ?? 1)), `${name} arrivals stay within client concurrency`);
  const platform = observations.slice(warmup).map(({ platform, placement, colo, cohort }) => ({ ...(platform ?? {}), placement, ingressColo: colo, cohort }));
  results.push({ name, layer, observed, concurrency: options.concurrency ?? 1, ...report.results[0], samples,
    records: measuredRecords, platform, cpuProfile, heap, expectedStatus: options.status ?? 200, errors: samples.filter((sample) => sample.status >= 400).length });
  process.stdout.write(`${name}: ${report.results[0].timingMs.p50.toFixed(2)} ms, ${samples.length} samples\n`);
  return { bodies: bodies.slice(warmup), records: measuredRecords };
}
async function control(path, body) {
  const response = await fetch(`${origin}/__${path}`, { method: "POST", headers: { "x-benchmark-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`control ${path}: ${response.status}`);
  const text = await response.text(); return text === "ok" ? text : JSON.parse(text);
}
async function health() {
  const response = await fetch(`${origin}/__health`, { headers: { "x-benchmark-key": key } });
  if (!response.ok) throw new Error(`health ${response.status}`); return response.json();
}
async function start() {
  child = spawn("pnpm", ["--filter", "@aotter/mantle-cloudflare", "exec", "wrangler", "dev", "--config", config, "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort),
    "--persist-to", persistence, "--var", `BENCHMARK_KEY:${key}`, "--var", `BENCH_LOCALES:${process.env.BENCH_LOCALES ?? "en"}`, "--log-level", "warn", "--show-interactive-dev-session=false"],
    { cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => logs.push(String(chunk))); child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited: ${child.exitCode}`);
    try {
      await health();
      if (process.env.BENCH_PROFILE !== "0") {
        try { cdp = await connectInspector(inspectorPort); } catch (error) { throw new Error(`CDP connection: ${error.message}`); }
      }
      return;
    } catch (error) { if (String(error).includes("CDP")) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("workerd startup timeout");
}
async function stop() {
  cdp?.close(); cdp = undefined;
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
  child = undefined;
}
async function availablePort() {
  const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function proof(method, url, token) {
  const htu = new URL(url); htu.hash = ""; htu.search = "";
  const payload = { jti: randomUUID(), htm: method, htu: htu.href, iat: Math.floor(Date.now() / 1000),
    ...(token ? { ath: Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url") } : {}) };
  const signing = `${Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dpopKey.privateKey, new TextEncoder().encode(signing));
  return `${signing}.${Buffer.from(signature).toString("base64url")}`;
}

async function connectInspector(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((target) => target.webSocketDebuggerUrl && target.title.includes("mantle-parity")) ?? targets.find((target) => target.webSocketDebuggerUrl);
  if (!target) throw new Error("CDP Worker target missing");
  // Miniflare requires Origin when a client sends User-Agent. Node's native
  // WebSocket cannot set that header; reuse Wrangler's already-installed ws.
  const packageRequire = createRequire(new URL("../packages/adapters/cloudflare/package.json", import.meta.url));
  const WebSocket = createRequire(packageRequire.resolve("wrangler/package.json"))("ws");
  const ws = new WebSocket(target.webSocketDebuggerUrl, { origin: "http://localhost" });
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${target.webSocketDebuggerUrl}`)), { once: true }); });
  let nextId = 0; const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data); const handler = pending.get(message.id);
    if (!handler) return; pending.delete(message.id); clearTimeout(handler.timeout);
    if (message.error) handler.reject(new Error(`CDP ${message.error.message}`)); else handler.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 10000);
    pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }));
  });
  await call("Profiler.enable"); await call("Profiler.setSamplingInterval", { interval: 100 });
  return { call, close() { ws.close(); } };
}

async function remoteRecords(ids) {
  const found = new Map(); const deadline = Date.now() + 30000;
  while (Date.now() < deadline && found.size < ids.length) {
    const missing = ids.filter((id) => !found.has(id));
    const received = missing.map((id) => remoteTail.records.get(id) ?? null);
    received.forEach((value, index) => { if (value) found.set(missing[index], value); });
    if (found.size < ids.length) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(found.size, ids.length, "all remote invocations have Tail timing and a correlated record");
  for (const id of ids) remoteTail.records.delete(id);
  return ids.map((id) => found.get(id));
}

async function probeCache() {
  const path = `/${itemLocale}/items/item-1?benchmark=${randomUUID()}`;
  const evidence = []; let expected;
  for (let i = 0; i < 10; i++) {
    const id = randomUUID(), start = performance.now();
    const response = await fetch(`${origin}${path}`, { headers: { "x-benchmark-key": key, "x-benchmark-request": id } });
    const ttfbMs = performance.now() - start, body = await response.text();
    assert.equal(response.status, 200); expected ??= body; assert.equal(body, expected);
    const cacheStatus = response.headers.get("cf-cache-status");
    const sample = { cacheStatus, ttfbMs, fullBodyMs: performance.now() - start, responseBytes: Buffer.byteLength(body),
      cacheControl: response.headers.get("cache-control"), rayColo: response.headers.get("cf-ray")?.split("-").at(-1) ?? null };
    if (cacheStatus === "HIT") {
      assert.equal((remoteTail.records.get(id) ?? null), null, "entrypoint HIT has no Worker invocation record");
      evidence.push(sample); break;
    }
    sample.originObservation = (await remoteRecords([id]))[0];
    evidence.push(sample);
  }
  assert(evidence.some((sample) => sample.cacheStatus === "MISS"), "deployed public cache MISS");
  assert(evidence.some((sample) => sample.cacheStatus === "HIT"), "deployed public cache HIT");
  return evidence;
}

async function connectRemoteTail() {
  const account = process.env.BENCH_ACCOUNT_ID;
  assert(account && /^[a-f0-9]{32}$/.test(account), "BENCH_ACCOUNT_ID required for remote native timing");
  const script = process.env.BENCH_SCRIPT ?? "mantle-parity-812";
  assert(/^[a-zA-Z0-9_-]+$/.test(script), "valid benchmark Worker name");
  const auth = JSON.parse(execFileSync("pnpm", ["--filter", "@aotter/mantle-cloudflare", "exec", "wrangler", "auth", "token",
    "--profile", process.env.BENCH_PROFILE_NAME ?? "default", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert(auth.token, "Wrangler authentication available");
  const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/tails`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ filters: [] }) });
  const created = await response.json();
  assert(response.ok && created.success, `native tail creation status ${response.status}`);
  const WebSocket = createRequire(packageRequire.resolve("wrangler/package.json"))("ws");
  const ws = new WebSocket(created.result.url, "trace-v1", { headers: { "User-Agent": `wrangler/${versions.wrangler}` } });
  const records = new Map();
  const close = async () => { ws.close(); await fetch(`${url}/${created.result.id}`, { method: "DELETE", headers }); };
  ws.on("message", (data) => {
    let event; try { event = JSON.parse(String(data)); } catch { return; }
    if (event.scriptName !== script) return;
    for (const log of event.logs ?? []) {
      if (log.message?.[0] !== "mantle-benchmark-v1" || typeof log.message[1] !== "string") continue;
      let data; try { data = JSON.parse(log.message[1]); } catch { continue; }
      if (!/^[a-f0-9-]{36}$/i.test(data?.id) || !data.observation) continue;
      const { record, bootId, colo, country, placement, cohort } = data.observation;
      if (records.size >= 2000) records.delete(records.keys().next().value);
      records.set(data.id, { record: record ?? null, bootId, colo, country, placement, cohort,
        platform: { source: "Cloudflare real-time trace-v1", cpuTimeMs: Number.isFinite(event.cpuTime) ? event.cpuTime : null,
          wallTimeMs: Number.isFinite(event.wallTime) ? event.wallTime : null, outcome: event.outcome,
          timestamp: event.eventTimestamp, scriptVersion: event.scriptVersion?.id ?? null, truncated: event.truncated } });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("native trace connection timeout")), 30000);
      ws.once("open", () => { clearTimeout(timeout); resolve(); });
      ws.once("error", () => { clearTimeout(timeout); reject(new Error("native trace connection failed")); });
    });
    ws.send(JSON.stringify({ debug: false }), { mask: false });
    // The socket can open before edge log subscriptions propagate. Confirm the
    // actual nonce before sampling; a fixed delay can silently lose cold records.
    const readyId = randomUUID();
    for (let attempt = 0; attempt < 30 && !records.has(readyId); attempt++) {
      const response = await fetch(`${origin}/health`, { headers: { "x-benchmark-key": key, "x-benchmark-layer": "F0",
        "x-benchmark-request": readyId, cookie: "__benchmark_origin=1" } });
      await response.arrayBuffer(); assert.equal(response.status, 200, "trace readiness floor");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(records.has(readyId), "native trace subscription delivers a correlated readiness nonce");
    records.delete(readyId);
    return { records, close };
  } catch (error) { await close(); throw error; }
}

function assertNativeBudget(records, expected, name) {
  const repeated = records.filter((sample) => sample.cohort === "repeat-in-isolate");
  assert(repeated.length, `${name}: repeat-in-isolate samples available`);
  assert(records.every(({ record, cohort }) => record.d1.failures === 0 && (cohort === "repeat-in-isolate"
    ? record.d1.statements === expected : record.d1.statements >= expected && record.d1.statements <= expected + 6)),
    `${name}: statement budget ${records.map(({ record, cohort }) => `${cohort}:${record.d1.statements}`).join(",")}`);
}
