#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = JSON.parse(execFileSync(
  "pnpm",
  ["--filter", "@aotter/mantle...", "list", "--depth", "-1", "--json"],
  { cwd: root, encoding: "utf8" },
)).filter((pkg) => !pkg.private).map((pkg) => [pkg.name, pkg.path]);
const separator = process.argv.indexOf("--");
const args = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
const command = separator < 0 ? [] : process.argv.slice(separator + 1);
const help = args.some((arg) => arg === "-h" || arg === "--help");

if (args.length === 1 && args[0] === "--self-test" && command.length === 0) {
  let rejected = false;
  try {
    assertExactTarballResolutions("version: 0.0.11-alpha.63", new Map([
      ["@aotter/mantle", "/tmp/exact-mantle.tgz"],
    ]));
  } catch (error) {
    rejected = error.message.includes("exact tarball");
  }
  if (!rejected) throw new Error("packed-consumer provenance self-test accepted a registry install");
  const source = join(tmpdir(), "source");
  if (!isWithin(source, join(source, "output")) || isWithin(source, join(tmpdir(), "output"))) {
    throw new Error("packed-consumer output boundary self-test failed");
  }
  const archived = archiveProject(join(root, "docs/examples/host-minimal-worker"));
  const entries = execFileSync("tar", ["-tf", "-"], { input: archived.bytes, encoding: "utf8" }).split("\n");
  if (!entries.includes("package.json") || entries.some((entry) => entry.includes("node_modules/"))) {
    throw new Error("packed-consumer committed subtree archive failed");
  }
  const probe = join(tmpdir(), "packed-consumer-peer-rules.json");
  writeFileSync(probe, `${JSON.stringify({ name: "probe", private: true }, null, 2)}\n`);
  addOverrides(probe, new Map([["@aotter/mantle", "/tmp/exact-mantle.tgz"]]));
  const patched = JSON.parse(readFileSync(probe, "utf8"));
  rmSync(probe);
  if (!patched.pnpm?.peerDependencyRules?.allowAny?.includes("@aotter/mantle")) {
    throw new Error("packed-consumer peer-rule self-test failed");
  }
  console.log("packed-consumer provenance and subtree self-test passed");
  process.exit(0);
}
if (help) {
  console.log("Usage: node scripts/check-packed-consumer.mjs --project <path> [--output <path>] -- <command> [args...]");
  process.exit(0);
}
const output = args.length === 4 && args[2] === "--output" && args[3]
  ? resolve(root, args[3])
  : null;
if (
  (args.length !== 2 && !output)
  || args[0] !== "--project"
  || !args[1]
  || command.length === 0
) {
  throw new Error("Usage: node scripts/check-packed-consumer.mjs --project <path> [--output <path>] -- <command> [args...]");
}
const project = resolve(root, args[1]);
if (!statSync(project, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`consumer project does not exist: ${project}`);
}
if (output && (isWithin(root, output) || isWithin(project, output))) {
  throw new Error("output must be outside the Core and consumer checkouts");
}
if (output && existsSync(output)) throw new Error(`output already exists: ${output}`);
const coreSha = gitSha(root);
const consumerSha = gitSha(project);

const temp = output ?? mkdtempSync(join(tmpdir(), "mantle-packed-consumer-"));
const artifacts = join(temp, "artifacts");
const consumer = join(temp, "consumer");
let complete = false;
try {
  if (output) mkdirSync(temp);
  mkdirSync(artifacts);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tarballs = new Map();
  for (const [name, directory] of packages) {
    run("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], root, true);
    const tarball = join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`pack did not create ${tarball}`);
    tarballs.set(name, tarball);
  }

  const { prefix, bytes } = archiveProject(project);
  mkdirSync(consumer);
  execFileSync("tar", ["-x", "-C", consumer], { input: bytes });
  addOverrides(join(consumer, "package.json"), tarballs);
  run("pnpm", ["install", "--no-frozen-lockfile"], consumer);
  const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
  assertExactTarballResolutions(lockfile, tarballs);

  const installed = findInstalled(consumer, packages.map(([name]) => name));
  let installedCount = 0;
  for (const [name] of packages) {
    const paths = installed.get(name) ?? [];
    installedCount += paths.length;
    for (const path of paths) {
      const actual = realpathSync(path);
      if (actual.startsWith(`${root}/`)) throw new Error(`consumer workspace-linked ${name}: ${actual}`);
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      if (manifest.version !== version) {
        throw new Error(`consumer installed ${name}@${manifest.version}; expected ${version}`);
      }
      if (JSON.stringify(manifest).includes("workspace:")) {
        throw new Error(`${name} tarball leaked a workspace: dependency`);
      }
    }
  }
  if (installedCount === 0) throw new Error("consumer did not install any Mantle package");

  run(command[0], command.slice(1), consumer);
  const generated = join(temp, "generated-cf");
  mkdirSync(generated);
  writeFileSync(join(generated, "package.json"), `${JSON.stringify({
    name: "generated-cf-smoke", private: true, type: "module",
    packageManager: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
    dependencies: {
      ...Object.fromEntries([...tarballs.keys()].filter((name) => name === "@aotter/mantle" ||
        ["@aotter/mantle-cloudflare", "@aotter/mantle-admin", "@aotter/mantle-admin-ui", "@aotter/mantle-auth", "@aotter/mantle-web"].includes(name))
        .map((name) => [name, version])),
      zod: "^4.5.0", hono: "^4.12.0", "better-auth": "1.7.2", aws4fetch: "^1.0.20",
    },
    devDependencies: { wrangler: "4.129.0", typescript: "^6.0.3", "@cloudflare/workers-types": "5.20260904.1" },
    pnpm: { overrides: Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`])),
      peerDependencyRules: { allowAny: [...tarballs.keys()] } },
  }, null, 2)}\n`);
  run("pnpm", ["install", "--no-frozen-lockfile"], generated);
  run("pnpm", ["exec", "mantle", "generate", "--host", "cf"], generated);
  run("pnpm", ["run", "build"], generated);
  run("pnpm", ["exec", "mantle", "generate", "--check"], generated);
  await smokeGenerated(generated);
  await smokeGeneratedSites(temp, tarballs, version);
  complete = true;
  console.log(JSON.stringify({
    core_sha: coreSha,
    consumer_sha: consumerSha,
    consumer: basename(project),
    consumer_path: prefix || ".",
    package_version: version,
    run_artifact_sha256: Object.fromEntries(
      [...tarballs].map(([name, path]) => [name, sha256(path)]),
    ),
  }, null, 2));
} finally {
  if (!output || !complete) rmSync(temp, { recursive: true, force: true });
}

async function smokeGenerated(directory) {
  const origin = "http://127.0.0.1:18789";
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1",
    "--port", "18789", "--inspector-port", "0"], {
    cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += String(chunk); });
  child.stderr.on("data", (chunk) => { logs += String(chunk); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`generated Worker exited ${child.exitCode}\n${logs}`);
      try { ready = (await fetch(origin)).status === 200; } catch { /* starting */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`generated Worker did not start\n${logs}`);
    const initialize = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "packed-smoke", version: "1" },
      } }) };
    for (const [path, expected, request] of [["/admin/sign-in", 503], ["/mcp", 200, initialize],
      ["/mcp/staff", 503, initialize]]) {
      const response = await fetch(`${origin}${path}`, request);
      if (response.status !== expected) throw new Error(`generated ${path}: ${response.status}, expected ${expected}`);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function smokeGeneratedSites(temp, tarballs, version) {
  const directory = join(temp, "generated-sites");
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    name: "generated-sites-smoke", private: true, type: "module",
    packageManager: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
    dependencies: {
      ...Object.fromEntries([...tarballs.keys()].filter((name) => name === "@aotter/mantle" ||
        ["@aotter/mantle-cloudflare", "@aotter/mantle-admin", "@aotter/mantle-admin-ui", "@aotter/mantle-web"].includes(name))
        .map((name) => [name, version])),
      zod: "^4.5.0", hono: "^4.12.0", "better-auth": "1.7.2", aws4fetch: "^1.0.20",
    },
    devDependencies: { wrangler: "4.129.0", typescript: "^6.0.3", "@cloudflare/workers-types": "5.20260904.1", esbuild: "^0.28.0" },
    pnpm: { overrides: Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`])),
      peerDependencyRules: { allowAny: [...tarballs.keys()] } },
  }, null, 2)}\n`);
  run("pnpm", ["install", "--no-frozen-lockfile"], directory);
  run("pnpm", ["exec", "mantle", "generate", "--host", "chatgpt-sites"], directory);
  let remoteRejected = false;
  try {
    execFileSync("node", ["scripts/smoke-local.mjs"], { cwd: directory, env: {
      ...process.env, MANTLE_TEST_ORIGIN: "https://example.com", MANTLE_TEST_OWNER_EMAIL: "owner@example.test",
    }, stdio: "pipe" });
  } catch { remoteRejected = true; }
  if (!remoteRejected) throw new Error("Sites identity simulator accepted a remote origin");
  const initial = readFileSync(join(directory, "drizzle/0000_mantle.sql"), "utf8");
  const initialState = readFileSync(join(directory, "drizzle/meta/mantle-state.json"), "utf8");
  const initialFingerprint = readFileSync(join(directory, "src/storage-fingerprint.json"), "utf8");
  const hosting = JSON.parse(readFileSync(join(directory, ".openai/hosting.json"), "utf8"));
  if (hosting.d1 !== "DB" || hosting.r2 || hosting.project_id) throw new Error("Generated Sites hosting metadata is invalid");
  run("pnpm", ["run", "build"], directory);
  run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "generated-sites", "--local"], directory);
  writeFileSync(join(directory, ".dev.vars"), "OWNER_EMAIL=owner@example.test\nPUBLIC_ORIGIN=http://127.0.0.1:18791\n");
  await withSitesWorker(directory, async origin => {
    execFileSync("pnpm", ["run", "smoke:local"], { cwd: directory, stdio: "inherit", env: {
      ...process.env, MANTLE_TEST_ORIGIN: origin, MANTLE_TEST_OWNER_EMAIL: "owner@example.test",
    } });
  });

  mkdirSync(join(directory, "manifests"));
  writeFileSync(join(directory, "manifests/site.yaml"), sitesManifest(false));
  writeFileSync(join(directory, "src/handlers.ts"), `import type { AnyHandler } from '@aotter/mantle/runtime';\nexport const handlers: Record<string, AnyHandler> = { echo: input => input };\n`);
  run("pnpm", ["exec", "mantle", "generate"], directory);
  run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "generated-sites", "--local"], directory);
  writeFileSync(join(directory, "drizzle/meta/mantle-state.json"), initialState);
  writeFileSync(join(directory, "src/storage-fingerprint.json"), initialFingerprint);
  run("pnpm", ["exec", "mantle", "generate"], directory);
  run("pnpm", ["run", "build"], directory);
  let entryId;
  await withSitesWorker(directory, async origin => {
    const owner = { "oai-authenticated-user-id": "mantle-local-owner", "oai-authenticated-user-email": "owner@example.test" };
    const call = (path, body) => fetch(`${origin}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let response = await call("/api/echo", { value: "ok" });
    if (response.status !== 200 || (await response.json()).data.value !== "ok") throw new Error("Sites HTTP Trigger did not invoke the handler");
    response = await call("/api/echo", { value: 42 });
    if (response.status !== 400) throw new Error("Sites HTTP Trigger validation status was not 400");
    const mcp = (path, method, params) => fetch(`${origin}${path}`, { method: "POST", headers: { ...owner,
      "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
    response = await mcp("/api/mcp/staff", "tools/call", { name: "create_draft_posts", arguments: { title: "Kept" } });
    if (response.status !== 200) throw new Error(`Sites staff MCP call failed: ${response.status}`);
    const body = await response.json();
    entryId = JSON.parse(body.result.content[0].text).id;
    response = await fetch(`${origin}/api/views/published-posts`);
    if (response.status !== 200 || (await response.json()).data.rows.length !== 0) throw new Error("Draft leaked into public View");
    response = await fetch(`${origin}/admin/api/entries/${entryId}?collection=posts`, { headers: owner });
    if (response.status !== 200 || (await response.json()).entry.data.title !== "Kept") throw new Error("Staff MCP draft was not persisted");
  });

  writeFileSync(join(directory, "manifests/site.yaml"), sitesManifest(true));
  run("pnpm", ["exec", "mantle", "generate"], directory);
  run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "generated-sites", "--local"], directory);
  run("pnpm", ["run", "build"], directory);
  run("pnpm", ["exec", "mantle", "generate", "--check"], directory);
  if (readFileSync(join(directory, "drizzle/0000_mantle.sql"), "utf8") !== initial) throw new Error("Sites generator replaced an applied migration");
  await withSitesWorker(directory, async origin => {
    const response = await fetch(`${origin}/admin/api/entries/${entryId}?collection=posts`, { headers: {
      "oai-authenticated-user-id": "mantle-local-owner", "oai-authenticated-user-email": "owner@example.test",
    } });
    if (response.status !== 200 || (await response.json()).entry.data.title !== "Kept") throw new Error("Sites additive migration lost existing data");
  });
  const withUnique = field => sitesManifest(true).replace("  title: Posts\n", `  title: Posts\n  uniqueIndexes:\n    - [${field}]\n`);
  const d1 = sql => run("pnpm", ["exec", "wrangler", "d1", "execute", "generated-sites", "--local", "--command", sql], directory, true);
  writeFileSync(join(directory, "manifests/site.yaml"), withUnique("title"));
  run("pnpm", ["exec", "mantle", "generate", "--review-unique-indexes"], directory);
  run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "generated-sites", "--local"], directory);
  const row = (id, title, rank) => `INSERT INTO posts (_mantle_id,_mantle_status,_mantle_version,_mantle_created_at,_mantle_updated_at,title,rank) VALUES ('${id}','draft',1,1,1,'${title}',${rank})`;
  d1(row("unique-a", "A", 1));
  d1(row("unique-b", "B", 1));
  writeFileSync(join(directory, "manifests/site.yaml"), withUnique("rank"));
  let conflict = false;
  try { run("pnpm", ["exec", "mantle", "generate", "--review-unique-indexes"], directory, true); }
  catch (error) { conflict = String(error.stderr).includes("UNIQUE_INDEX_CONFLICT"); }
  if (!conflict || existsSync(join(directory, "drizzle/0004_mantle.sql"))) throw new Error("Unique-index preflight did not fail before mutation");
  d1("UPDATE posts SET rank=2 WHERE _mantle_id='unique-b'");
  run("pnpm", ["exec", "mantle", "generate", "--review-unique-indexes"], directory);
  if (!existsSync(join(directory, "drizzle/meta/0004_mantle.review.json"))) throw new Error("Reviewed unique-index report missing");
  const review = JSON.parse(readFileSync(join(directory, "drizzle/meta/0004_mantle.review.json"), "utf8"));
  const marker = () => JSON.parse(execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "generated-sites", "--local", "--command",
    "SELECT fingerprint FROM _mantle_storage_state WHERE id=1", "--json"], { cwd: directory, encoding: "utf8" }))[0].results[0].fingerprint;
  d1(row("unique-late", "Late", 2));
  let applyRejected = false;
  try { run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "generated-sites", "--local"], directory, true); }
  catch { applyRejected = true; }
  if (!applyRejected || marker() !== review.sourceFingerprint) throw new Error("Failed D1 unique migration did not roll back to its source fingerprint");
  d1("DELETE FROM posts WHERE _mantle_id='unique-late'");
  run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "generated-sites", "--local"], directory);
  d1(row("unique-c", "A", 3));
  let duplicateRejected = false;
  try { d1(row("unique-d", "D", 3)); } catch { duplicateRejected = true; }
  if (!duplicateRejected) throw new Error("Replaced unique index did not reject duplicate rank");
}

function sitesManifest(rank) {
  return `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    properties:
      title: { type: string }
${rank ? "      rank: { type: integer }\n" : ""}---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: published-posts }
spec:
  surface: public
  from: posts
  fields: [id, title]
  filter: { eq: { field: status, value: published } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: echo }
spec:
  input: { type: object, required: [value], properties: { value: { type: string } } }
  output: { type: object, properties: { value: { type: string } } }
  handler: { kind: ref, ref: echo }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: echo-http }
spec:
  source: { kind: http, method: POST, path: /api/echo }
  target: { procedure: echo }
`;
}

async function withSitesWorker(directory, probe) {
  const origin = "http://127.0.0.1:18791";
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", "18791", "--inspector-port", "0"], {
    cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += String(chunk); });
  child.stderr.on("data", chunk => { logs += String(chunk); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`generated Sites Worker exited ${child.exitCode}\n${logs}`);
      try { ready = (await fetch(`${origin}/health`)).status === 200; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`generated Sites Worker did not start\n${logs}`);
    await probe(origin);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      if (child.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

function addOverrides(path, tarballs) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.pnpm ??= {};
  manifest.pnpm.overrides = {
    ...(manifest.pnpm.overrides ?? {}),
    ...Object.fromEntries([...tarballs].map(([name, path]) => [name, `file:${path}`])),
  };
  // file: overrides rewrite peer specifiers to file: paths; pnpm 9 then reports
  // "unmet peer @scope/pkg@file:...tgz: found 0.1.2-..." even when that version
  // is installed. allowedVersions: "*" does not silence it; allowAny does.
  // Disposable consumer only — registry peer checks stay.
  manifest.pnpm.peerDependencyRules = {
    ...(manifest.pnpm.peerDependencyRules ?? {}),
    allowAny: [...new Set([
      ...(manifest.pnpm.peerDependencyRules?.allowAny ?? []),
      ...tarballs.keys(),
    ])],
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertExactTarballResolutions(lockfile, tarballs) {
  for (const [name, tarball] of tarballs) {
    if (!lockfile.includes(`file:${tarball}`)) {
      throw new Error(`consumer lock did not resolve ${name} from its exact tarball`);
    }
  }
}

function findInstalled(directory, names, found = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.name !== "node_modules") {
      findInstalled(path, names, found);
      continue;
    }
    for (const name of names) addIfDirectory(found, name, join(path, ...name.split("/")));
    const store = join(path, ".pnpm");
    if (!existsSync(store)) continue;
    for (const packageEntry of readdirSync(store, { withFileTypes: true })) {
      if (!packageEntry.isDirectory()) continue;
      for (const name of names) {
        addIfDirectory(found, name, join(store, packageEntry.name, "node_modules", ...name.split("/")));
      }
    }
  }
  return found;
}

function addIfDirectory(found, name, path) {
  let stats;
  try {
    stats = statSync(path, { throwIfNoEntry: false });
  } catch {
    return;
  }
  if (!stats?.isDirectory()) return;
  const paths = found.get(name) ?? [];
  if (!paths.includes(path)) paths.push(path);
  found.set(name, paths);
}

function run(command, args, cwd, quiet = false) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, CI: "1" },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function gitSha(directory) {
  const top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (!isWithin(realpathSync(top), realpathSync(directory))) {
    throw new Error(`${directory} is outside its git checkout`);
  }
  const status = execFileSync("git", ["-C", directory, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (status) throw new Error(`${directory} is not clean; refusing immutable SHA evidence`);
  const sha = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot record immutable git SHA for ${directory}`);
  return sha;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function archiveProject(directory) {
  const top = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const prefix = execFileSync("git", ["-C", directory, "rev-parse", "--show-prefix"], { encoding: "utf8" }).trim().replace(/\/$/, "");
  const bytes = execFileSync("git", ["-C", top, "archive", prefix ? `HEAD:${prefix}` : "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
  return { prefix, bytes };
}
