#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const coreRoot = resolve(new URL("..", import.meta.url).pathname);
const startersIndex = process.argv.indexOf("--starters");
const starters = startersIndex >= 0 ? resolve(process.argv[startersIndex + 1] ?? "") : null;
// Landing alpha.63 wrote bundle.version (without the Git tag's `v`) into site metadata.
const sourceRef = "0.0.11-alpha.63";
const sourceTag = `v${sourceRef}`;
const targetRef = "bridge-under-test";
const nextRef = "bridge-next-under-test";
const keep = process.argv.includes("--keep");

if (!starters || !(await stat(starters).catch(() => null))?.isDirectory()) {
  console.error("Usage: node scripts/check-alpha63-upgrade.mjs --starters <mantle-starters-checkout>");
  process.exit(2);
}

const oldBundle = await gitShow(starters, sourceTag, "provision-bundles/blank.json");
const oldUpdater = await gitShow(starters, sourceTag, "blank/scripts/update.mjs");
const oldMaterializer = await gitShow(starters, sourceTag, "blank/scripts/materialize.mjs");
const currentMaterializer = await import(pathToFileURL(
  join(starters, "scripts", "materialize-bundle.mjs"),
).href);
const targetBundle = await readFile(join(starters, "provision-bundles", "blank.json"), "utf8");
const nextBundleValue = JSON.parse(targetBundle);
nextBundleValue.version = nextRef;
nextBundleValue.files["bridge-next.txt"] = "next immutable bundle\n";
const nextBundle = `${JSON.stringify(nextBundleValue, null, 2)}\n`;
const temporary = await mkdtemp(join(tmpdir(), "mantle-alpha63-upgrade-"));
let server;

try {
  const tooling = join(temporary, "legacy-tooling");
  const project = join(temporary, "site");
  await mkdir(tooling, { recursive: true });
  await mkdir(project, { recursive: true });
  const oldBundlePath = join(tooling, "source.json");
  const targetBundlePath = join(tooling, "target.json");
  const updaterPath = join(tooling, "update.mjs");
  const materializerPath = join(tooling, "materialize.mjs");
  const preloadPath = join(tooling, "fetch-bundles.mjs");
  await writeFile(oldBundlePath, oldBundle);
  await writeFile(targetBundlePath, targetBundle);
  await writeFile(updaterPath, oldUpdater);
  await writeFile(materializerPath, oldMaterializer);
  await writeFile(preloadPath, legacyFetchPreload());

  const { materializeBundle } = await import(pathToFileURL(materializerPath).href);
  materializeBundle(project, JSON.parse(oldBundle), placeholderValues(sourceRef));
  await addUserOwnedChanges(project);
  const protectedPaths = [
    "manifests/custom-audit.yaml",
    "src/business/custom-handler.ts",
    "src/worker/routes/custom.ts",
    "src/web/pages/HomePage.tsx",
    "src/mantle/config.ts",
    "src/mantle/handlers/index.ts",
    "src/mantle/manifests.ts",
    "src/worker/app.ts",
    "src/index.ts",
    "wrangler.toml",
  ];
  const portedExactPaths = [
    "manifests/custom-audit.yaml",
    "src/business/custom-handler.ts",
    "src/worker/routes/custom.ts",
  ];
  const before = await hashes(project, protectedPaths);

  await run("pnpm", ["install", "--no-frozen-lockfile"], project);
  await run("pnpm", ["typecheck"], project);
  await exerciseBridgeWorker(project, "legacy alpha.63");

  await run(
    process.execPath,
    [
      "--import",
      preloadPath,
      updaterPath,
      "--ref",
      targetRef,
      "--report",
      ".mantle/legacy-update-report.json",
    ],
    project,
    {
      MANTLE_OLD_BUNDLE: oldBundlePath,
      MANTLE_TARGET_BUNDLE: targetBundlePath,
      MANTLE_OLD_REF: sourceRef,
      MANTLE_TARGET_REF: targetRef,
    },
  );
  await assertHashes(project, protectedPaths, before, "legacy updater");
  const legacyReport = await readJson(join(project, ".mantle", "legacy-update-report.json"));
  assertEqual(legacyReport.source_ref, sourceRef, "legacy source ref");
  assertEqual(legacyReport.target_ref, targetRef, "legacy target ref");
  assertPaths(legacyReport.local?.differing, [
    "src/web/pages/HomePage.tsx",
    "src/mantle/config.ts",
    "src/mantle/handlers/index.ts",
    "src/mantle/manifests.ts",
    "src/worker/app.ts",
    "src/index.ts",
    "wrangler.toml",
  ], "legacy local edits");

  server = createServer((request, response) => {
    const [ref, filename] = (request.url ?? "").split("/").filter(Boolean);
    if (filename !== "blank.json") {
      response.writeHead(404).end("not found");
      return;
    }
    const requestedRef = decodeURIComponent(ref ?? "");
    const body = requestedRef === sourceTag
      ? oldBundle
      : requestedRef === targetRef
      ? targetBundle
      : requestedRef === nextRef
      ? nextBundle
      : null;
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(body ?? "not found");
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("upgrade server has no port");
  const bundleBaseUrl = `http://127.0.0.1:${address.port}/{ref}`;
  const tarballs = await packCore(join(temporary, "artifacts"));
  await applyBridgeTooling(project, tarballs);
  await run("pnpm", ["install", "--no-frozen-lockfile"], project);
  const installedMantle = await realpath(join(project, "node_modules", "@aotter", "mantle"));
  if (installedMantle.startsWith(coreRoot)) {
    throw new Error(`bridge installed a workspace link instead of packed Core: ${installedMantle}`);
  }
  const bridgedPackage = await readJson(join(project, "package.json"));
  assertEqual(bridgedPackage.scripts?.["mantle:update"], "mantle update", "Core update script");
  if (!String(bridgedPackage.dependencies?.["@aotter/mantle"] ?? "").startsWith("file:")) {
    throw new Error("bridge did not install the exact packed umbrella package");
  }

  await run("pnpm", [
    "mantle:update",
    "--ref",
    targetRef,
    "--bundle-base-url",
    bundleBaseUrl,
    "--report",
    ".mantle/core-bridge-report.json",
  ], project);
  const coreReport = await readJson(join(project, ".mantle", "core-bridge-report.json"));
  assertEqual(coreReport.source_ref, sourceRef, "Core source ref");
  assertEqual(coreReport.target_ref, targetRef, "Core target ref");
  assertEqual(coreReport.metadata_migration?.required, true, "metadata migration required");
  assertPaths(coreReport.local?.differing, [
    "src/web/pages/HomePage.tsx",
    "src/mantle/config.ts",
    "src/mantle/handlers/index.ts",
    "src/mantle/manifests.ts",
    "src/worker/app.ts",
    "src/index.ts",
    "wrangler.toml",
  ], "Core local edits");
  assertPaths(coreReport.local?.removed_upstream, [
    "manifests/custom-audit.yaml",
    "src/business/custom-handler.ts",
    "src/worker/routes/custom.ts",
  ], "Core project-owned files");

  await applyReviewedFacadePort({
    project,
    targetBundle: JSON.parse(targetBundle),
    sourceBundle: JSON.parse(oldBundle),
    materializeBundle: currentMaterializer.materializeBundle,
    targetRoot: join(temporary, "reviewed-target"),
    tarballs,
  });
  await assertHashes(project, portedExactPaths, before, "reviewed façade port");
  await assertFile(join(project, "public", "index.html"));
  await assertMissing(project, [
    "src/mantle/config.ts",
    "src/worker/app.ts",
    "scripts/update.mjs",
    "kiwa-ui.json",
    "components/ui/button.tsx",
  ]);
  await exerciseBridgeWorker(project, "reviewed façade port");

  await applyMetadataMigration(project, targetRef, bundleBaseUrl);
  const launchState = await readJson(join(project, ".mantle", "launch-state.json"));
  const features = await readJson(join(project, ".mantle", "features.json"));
  assertEqual(launchState.starter_ref, targetRef, "bridged starter ref");
  assertEqual(features.registry?.version, targetRef, "bridged registry version");
  assertEqual(features.registry?.bundleBaseUrl, bundleBaseUrl, "bridged bundle source");

  features.registry.version = nextRef;
  await writeFile(
    join(project, ".mantle", "features.json"),
    `${JSON.stringify(features, null, 2)}\n`,
  );
  await run("pnpm", [
    "mantle:update",
    "--report",
    ".mantle/core-next-report.json",
  ], project);
  const nextReport = await readJson(join(project, ".mantle", "core-next-report.json"));
  assertEqual(nextReport.source_ref, targetRef, "next-hop source ref");
  assertEqual(nextReport.target_ref, nextRef, "next-hop target ref");
  assertPaths(nextReport.upstream?.missing_current, ["bridge-next.txt"], "next-hop bundle");

  await run("pnpm", ["generate"], project);
  await assertHashes(project, portedExactPaths, before, "packed Core CLI bridge");
  await assertFile(join(project, ".mantle", "generated", "site.ts"));
  const projectedSkill = await readFile(
    join(project, ".agent", "skills", "mantle-develop", "SKILL.md"),
    "utf8",
  );
  if (
    !projectedSkill.includes("`src/mantle/config.ts`")
    || !projectedSkill.includes("typed `extend`")
    || !projectedSkill.includes("shadcn-style")
    || !projectedSkill.includes("v0.0.11-alpha.63")
    || !projectedSkill.includes("Overlay seed")
    || !projectedSkill.includes("`mantle update`")
  ) {
    throw new Error("Core CLI omitted the legacy-surface override/eject guidance");
  }
  if (/create\s+.*src\/mantle\/config\.ts/i.test(projectedSkill)) {
    throw new Error("Core CLI told the site to recreate legacy default assembly");
  }
  for (const path of [
    join(installedMantle, "docs", "site-overrides.md"),
    join(installedMantle, "skills", "update", "SKILL.md"),
  ]) {
    const guidance = await readFile(path, "utf8");
    if (
      !guidance.includes("pnpm dlx @aotter/mantle@0.0.11-alpha.64 update")
      || !guidance.includes("--ref v0.0.11-alpha.64")
      || !guidance.includes(
        "https://raw.githubusercontent.com/aotter/mantle-starters/{ref}/provision-bundles",
      )
    ) {
      throw new Error(`alpha.63 bridge guidance is incomplete in ${path}`);
    }
  }

  console.log(
    `alpha.63 upgrade bridge passed: ${portedExactPaths.length} source files preserved, `
      + "config/route/scheduled/UI behavior ported; legacy comparator → reviewed façade "
      + "port → packed Core CLI → configured next-hop update",
  );
} finally {
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  if (keep) console.log(`alpha.63 upgrade fixture retained: ${temporary}`);
  else await rm(temporary, { recursive: true, force: true });
}

async function gitShow(repository, ref, path) {
  const { stdout } = await exec("git", ["show", `${ref}:${path}`], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

async function packCore(artifacts) {
  await mkdir(artifacts, { recursive: true });
  const version = (await readJson(join(coreRoot, "package.json"))).version;
  const packages = [
    ["@aotter/mantle-spec", "packages/mantle-spec"],
    ["@aotter/mantle-admin-ui", "packages/mantle-admin-ui"],
    ["@aotter/mantle-runtime", "packages/mantle-runtime"],
    ["@aotter/mantle-cloudflare", "packages/adapters/cloudflare"],
    ["@aotter/mantle", "packages/mantle"],
  ];
  const tarballs = {};
  for (const [name, directory] of packages) {
    await run(
      "pnpm",
      ["-C", join(coreRoot, directory), "pack", "--pack-destination", artifacts],
      coreRoot,
      {},
      true,
    );
    const path = join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    await assertFile(path);
    tarballs[name] = path;
  }
  return tarballs;
}

async function applyBridgeTooling(project, tarballs) {
  const path = join(project, "package.json");
  const manifest = await readJson(path);
  manifest.scripts = {
    ...manifest.scripts,
    generate: "mantle generate",
    "check:generated": "mantle generate --check",
    "mantle:update": "mantle update",
  };
  manifest.dependencies["@aotter/mantle"] = `file:${tarballs["@aotter/mantle"]}`;
  if (manifest.devDependencies?.["@aotter/mantle-spec"]) {
    manifest.devDependencies["@aotter/mantle-spec"] = `file:${tarballs["@aotter/mantle-spec"]}`;
  }
  manifest.pnpm = {
    ...(manifest.pnpm ?? {}),
    overrides: {
      ...(manifest.pnpm?.overrides ?? {}),
      ...Object.fromEntries(
        Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
    },
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function applyReviewedFacadePort({
  project,
  targetBundle,
  sourceBundle,
  materializeBundle,
  targetRoot,
  tarballs,
}) {
  await mkdir(targetRoot, { recursive: true });
  materializeBundle(targetRoot, targetBundle, placeholderValues(targetRef));

  const metadata = new Set([
    ".mantle/features.json",
    ".mantle/launch-state.json",
  ]);
  for (const path of Object.keys(sourceBundle.files ?? {}).map(materializedPath)) {
    if (!metadata.has(path)) await rm(join(project, path), { recursive: true, force: true });
  }
  for (const path of Object.keys(targetBundle.files ?? {}).map(materializedPath)) {
    if (metadata.has(path)) continue;
    const source = join(targetRoot, path);
    const destination = join(project, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }

  await writeProjectFile(project, "public/index.html", `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Upgrade Fixture</title></head>
<body><main><h1>Upgrade Fixture</h1><p data-upgrade-marker>Project-owned UI retained by the façade port.</p></main></body>
</html>
`);
  await writeProjectFile(project, "src/index.ts", `import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { manifest } from "../.mantle/generated/site.js";
import { customAuditHandler } from "./business/custom-handler.js";
import { mountCustomRoute } from "./worker/routes/custom.js";

interface SiteEnv extends Env {
  readonly AUDIT_QUEUE: Queue<{ readonly kind: "scheduled-audit" }>;
}

const worker = createMantleWorker<SiteEnv>({
  manifest,
  handlers: { "custom-audit": customAuditHandler },
  extend: () => ({ mount: ({ app }) => mountCustomRoute(app) }),
});

export default {
  fetch(request, env, ctx) {
    return worker.fetch(request, env, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.AUDIT_QUEUE.send({ kind: "scheduled-audit" }));
  },
} satisfies ExportedHandler<SiteEnv>;
`);

  const wranglerPath = join(project, "wrangler.jsonc");
  const wrangler = await readJson(wranglerPath);
  wrangler.assets = { directory: "./public" };
  wrangler.queues = {
    producers: [{ binding: "AUDIT_QUEUE", queue: "mantle-upgrade-audit" }],
  };
  await writeFile(wranglerPath, `${JSON.stringify(wrangler, null, 2)}\n`);

  await applyBridgeTooling(project, tarballs);
  const packagePath = join(project, "package.json");
  const packageManifest = await readJson(packagePath);
  packageManifest.dependencies.hono = "^4.12.32";
  await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);
  await run("pnpm", ["install", "--no-frozen-lockfile"], project);
  await run("pnpm", ["generate"], project);
  await run("pnpm", ["typecheck"], project);

  const entry = await readFile(join(project, "src", "index.ts"), "utf8");
  for (const required of ["createMantleWorker", "mountCustomRoute", "scheduled-audit"]) {
    if (!entry.includes(required)) throw new Error(`reviewed façade port omitted ${required}`);
  }
}

function materializedPath(path) {
  return path.replace(/\.template$/, "");
}

async function applyMetadataMigration(project, ref, bundleBaseUrl) {
  const launchPath = join(project, ".mantle", "launch-state.json");
  const featuresPath = join(project, ".mantle", "features.json");
  const launchState = await readJson(launchPath);
  const features = await readJson(featuresPath);
  launchState.starter_ref = ref;
  features.registry = {
    ...(features.registry ?? {}),
    version: ref,
    bundleBaseUrl,
  };
  await writeFile(launchPath, `${JSON.stringify(launchState, null, 2)}\n`);
  await writeFile(featuresPath, `${JSON.stringify(features, null, 2)}\n`);
}

function placeholderValues(ref) {
  return {
    PROJECT_NAME: "alpha63-upgrade-fixture",
    ARCHETYPE: "blank",
    AUTH_MODE: "self-managed",
    BRAND: "Upgrade Fixture",
    DESCRIPTION: "Preserves project-owned Mantle changes.",
    INSTALL_SUMMARY: "Immutable alpha.63 upgrade fixture.",
    LOCALES: '["en"]',
    CANONICAL_LOCALE: "en",
    STARTER_REF: ref,
    GITHUB_OWNER: "fixture-owner",
    ADMIN_GITHUB_LOGIN: "fixture-owner",
    SITE_OWNER_EMAIL: "owner@example.com",
    SITE_URL: "https://upgrade.example",
    AFTER_LAUNCH_SKILL_URL: "https://mantle.tools/skill/after-launch?id=upgrade-fixture",
    INSTALL_TIMESTAMP: "2026-01-01T00:00:00.000Z",
  };
}

async function addUserOwnedChanges(project) {
  await writeProjectFile(project, "manifests/custom-audit.yaml", `apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: custom-audits }
spec:
  title: Custom audit
  schema:
    type: object
    required: [message]
    properties:
      message: { type: string }
  lifecycle: none
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: custom-audit }
spec:
  input:
    type: object
    additionalProperties: false
    required: [message]
    properties:
      message: { type: string, minLength: 1 }
  output:
    type: object
    additionalProperties: false
    required: [accepted]
    properties:
      accepted: { type: boolean }
  handler: { kind: ref, ref: custom-audit }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: custom-audit-http }
spec:
  source: { kind: http, method: POST, path: /api/custom-audit }
  target: { procedure: custom-audit }
`);
  await writeProjectFile(project, "src/business/custom-handler.ts", `import type { AnyHandler } from "@aotter/mantle/runtime";

export const customAuditHandler: AnyHandler = async (input) => {
  const message = typeof input === "object" && input !== null && "message" in input
    ? (input as { readonly message?: unknown }).message
    : null;
  return { accepted: typeof message === "string" && message.length > 0 };
};
`);
  await writeProjectFile(project, "src/worker/routes/custom.ts", `import type { Env as HonoEnv, Hono } from "hono";

export function mountCustomRoute<E extends HonoEnv>(app: Hono<E>): void {
  app.get("/custom", (c) => c.json({ projectOwned: true }));
}
`);
  const handlersPath = join(project, "src", "mantle", "handlers", "index.ts");
  await writeFile(handlersPath, `import type { AnyHandler } from "@aotter/mantle/runtime";
import { customAuditHandler } from "../../business/custom-handler.js";

export function buildHandlers(): Readonly<Record<string, AnyHandler>> {
  return { "custom-audit": customAuditHandler };
}
`);
  const manifestsPath = join(project, "src", "mantle", "manifests.ts");
  await writeFile(manifestsPath, `import { parseManifestsOrThrow, type Manifest } from "@aotter/mantle/spec";
import customAuditYaml from "../../manifests/custom-audit.yaml";
import exampleYaml from "../../manifests/example.yaml";

export function loadManifests(): readonly Manifest[] {
  return parseManifestsOrThrow([exampleYaml, customAuditYaml], { context: "upgrade-fixture" });
}
`);
  const appPath = join(project, "src", "worker", "app.ts");
  const app = await readFile(appPath, "utf8");
  await writeFile(
    appPath,
    app
      .replace(
        'import { createHomeRoutes } from "./routes/home.js";',
        'import { createHomeRoutes } from "./routes/home.js";\nimport { mountCustomRoute } from "./routes/custom.js";',
      )
      .replace(
        "  mountAuthorize(app, { auth, loginPath: \"/admin/sign-in\" });",
        "  mountAuthorize(app, { auth, loginPath: \"/admin/sign-in\" });\n  mountCustomRoute(app);",
      ),
  );
  const homePath = join(project, "src", "web", "pages", "HomePage.tsx");
  const home = await readFile(homePath, "utf8");
  await writeFile(
    homePath,
    home.replace(
      "      <main>",
      '      <main>\n        <p data-upgrade-marker>Project-owned UI retained by the façade port.</p>',
    ),
  );
  await appendFile(join(project, "src", "mantle", "config.ts"), `

export interface Env {
  readonly AUDIT_QUEUE: Queue<{ readonly kind: "scheduled-audit" }>;
}
`);
  const entryPath = join(project, "src", "index.ts");
  const entry = await readFile(entryPath, "utf8");
  const marker = "export default {\n";
  if (!entry.includes(marker)) throw new Error("alpha.63 Worker entry marker is missing");
  await writeFile(entryPath, entry.replace(marker, `${marker}  scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(env.AUDIT_QUEUE.send({ kind: "scheduled-audit" }));
  },
`));
  await appendFile(join(project, "wrangler.toml"), `

[[queues.producers]]
binding = "AUDIT_QUEUE"
queue = "mantle-upgrade-audit"
`);
}

async function writeProjectFile(root, path, source) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source);
}

function legacyFetchPreload() {
  return `import { readFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/provision-bundles/blank.json")) {
    const ref = url.pathname.split("/")[3];
    const path = ref === process.env.MANTLE_OLD_REF
      ? process.env.MANTLE_OLD_BUNDLE
      : ref === process.env.MANTLE_TARGET_REF
      ? process.env.MANTLE_TARGET_BUNDLE
      : null;
    if (path) return new Response(await readFile(path), { headers: { "content-type": "application/json" } });
  }
  return originalFetch(input, init);
};
`;
}

async function hashes(root, paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
  ])));
}

async function assertHashes(root, paths, expected, label) {
  const actual = await hashes(root, paths);
  for (const path of paths) assertEqual(actual[path], expected[path], `${label} changed ${path}`);
}

function assertPaths(entries, required, label) {
  const paths = new Set((entries ?? []).map((entry) => entry.path));
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`${label} did not report ${path}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

async function assertFile(path) {
  if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`missing ${path}`);
}

async function assertMissing(root, paths) {
  for (const path of paths) {
    if (await stat(join(root, path)).catch(() => null)) {
      throw new Error(`reviewed façade port retained legacy boilerplate ${path}`);
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exerciseBridgeWorker(project, label) {
  const port = await freePort();
  const logs = [];
  const worker = spawn(
    join(coreRoot, "packages", "adapters", "cloudflare", "node_modules", ".bin", "wrangler"),
    ["dev", "--port", String(port), "--inspector-port", "0", "--test-scheduled"],
    { cwd: project, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let spawnError;
  worker.once("error", (error) => { spawnError = error; });
  worker.stdout.on("data", (chunk) => logs.push(String(chunk)));
  worker.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(`${base}/custom`, worker, () => spawnError, logs);

    const route = await timedFetch(`${base}/custom`);
    assertEqual(route.status, 200, `${label} custom route status`);
    assertEqual((await route.json()).projectOwned, true, `${label} custom route body`);

    const procedure = await timedFetch(`${base}/api/custom-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "preserved" }),
    });
    const procedureText = await procedure.text();
    if (procedure.status !== 200) {
      throw new Error(
        `${label} custom Procedure returned ${procedure.status}: ${procedureText}\n${logs.join("")}`,
      );
    }
    assertEqual(JSON.parse(procedureText).data?.accepted, true, `${label} custom Procedure body`);

    const page = await timedFetch(base);
    assertEqual(page.status, 200, `${label} UI status`);
    if (!(await page.text()).includes("Project-owned UI")) {
      throw new Error(`${label} omitted the project-owned UI marker`);
    }

    const scheduled = await timedFetch(`${base}/__scheduled`);
    assertEqual(scheduled.status, 200, `${label} scheduled Queue status`);
  } finally {
    await stopWorker(worker);
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("port probe has no port");
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return address.port;
}

async function waitUntilReady(url, worker, spawnError, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError()) throw spawnError();
    if (worker.exitCode !== null) break;
    try {
      const response = await timedFetch(url, {}, 750);
      if (response.status > 0) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Wrangler did not start for bridge fixture:\n${logs.join("")}`);
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
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

async function run(executable, args, cwd, extraEnv = {}, quiet = false) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(
        `${executable} ${args.join(" ")} exited ${code ?? signal}${output ? `\n${output}` : ""}`,
      ));
    });
  });
}
