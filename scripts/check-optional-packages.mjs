#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = rootManifest.version;
const temp = mkdtempSync(join(tmpdir(), "mantle-optional-packages-"));
const artifacts = join(temp, "artifacts");
const localState = mkdtempSync(join(root, "docs/examples/host-minimal-worker/.env.pack-check-"));
const zod = `file:${realpathSync(join(root, "packages/mantle-runtime/node_modules/zod"))}`;
const hono = `file:${realpathSync(join(root, "packages/adapters/cloudflare/node_modules/hono"))}`;

try {
  mkdirSync(artifacts);
  writeFileSync(join(localState, "sentinel"), "local test state must not be published");
  const tarballs = Object.fromEntries([
    ["@aotter/mantle", "packages/mantle"],
    ["@aotter/mantle-spec", "packages/mantle-spec"],
    ["@aotter/mantle-runtime", "packages/mantle-runtime"],
    ["@aotter/mantle-mcp", "packages/mantle-mcp"],
    ["@aotter/mantle-ui", "packages/mantle-ui"],
    ["@aotter/mantle-web", "packages/mantle-web"],
    ["@aotter/mantle-indexeddb", "packages/adapters/indexeddb"],
    ["@aotter/mantle-admin-ui", "packages/mantle-admin-ui"],
    ["@aotter/mantle-admin", "packages/mantle-admin"],
    ["@aotter/mantle-auth", "packages/mantle-auth"],
  ].map(([name, directory]) => {
    execFileSync("pnpm", ["-C", directory, "pack", "--pack-destination", artifacts], {
      cwd: root,
      stdio: "ignore",
    });
    return [name, join(artifacts, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`)];
  }));

  installConsumer("spec-only", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    zod,
  }, `
    const spec = await import("@aotter/mantle-spec");
    const parsed = spec.parseManifestSources({ sources: [] });
    if (!parsed.ok) throw new Error("empty source set did not parse");
    const recursive = spec.jsonSchemaToZod({
      $defs: {
        node: {
          oneOf: [
            { type: "object", required: ["value"], properties: { value: { const: "leaf" } }, additionalProperties: false },
            { type: "object", required: ["next"], properties: { next: { $ref: "#/$defs/node" } }, additionalProperties: false },
          ],
        },
      },
      $ref: "#/$defs/node",
    });
    if (!recursive.safeParse({ next: { value: "leaf" } }).success ||
        recursive.safeParse({ value: "leaf", next: { value: "leaf" } }).success) {
      throw new Error("packed recursive oneOf validation failed");
    }
  `);
  if (existsSync(join(temp, "spec-only/node_modules/@aotter/mantle-runtime"))) {
    throw new Error("spec-only consumer installed @aotter/mantle-runtime");
  }

  installConsumer("core-only", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    zod,
  }, `
    const spec = await import("@aotter/mantle-spec");
    const core = await import("@aotter/mantle-runtime");
    const testing = await import("@aotter/mantle-runtime/testing/storage");
    if (typeof testing.runStorageConformance !== "function" ||
        "runStorageConformance" in core) {
      throw new Error("storage conformance must be available only through its testing subpath");
    }
    const parsed = spec.parseManifestSources({ sources: [] });
    if (!parsed.ok) throw new Error("empty source set did not parse");
    const linked = spec.linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error("empty source set did not link");
    const compiled = core.compileRuntimePlan(linked.value);
    if (!compiled.ok) throw new Error("empty source set did not compile");
    const runtime = await core.bootMantleRuntime({
      plan: compiled.value,
      storage: {
        prepare: async () => ({ entries: {}, views: {}, localePolicy: {} }),
      },
    });
    if (runtime.revision !== compiled.value.semanticFingerprint) {
      throw new Error("headless runtime did not bind application-owned ports");
    }
  `);
  for (const optional of [
    "mantle-web",
    "mantle-mcp",
    "mantle-admin",
    "mantle-admin-ui",
    "mantle-auth",
    "mantle-bun",
    "mantle-indexeddb",
    "mantle-vercel",
  ]) {
    if (existsSync(join(temp, `core-only/node_modules/@aotter/${optional}`))) {
      throw new Error(`core-only consumer installed @aotter/${optional}`);
    }
  }

  installConsumer("umbrella-core", {
    "@aotter/mantle": `file:${tarballs["@aotter/mantle"]}`,
    zod,
  }, `
    const core = await import("@aotter/mantle/runtime");
    const spec = await import("@aotter/mantle/spec");
    if (typeof core.bootMantleRuntime !== "function" ||
        typeof core.createMantleRuntime !== "function" ||
        typeof spec.parseManifestSources !== "function") {
      throw new Error("umbrella Core exports are incomplete");
    }
  `, {
    "@aotter/mantle": `file:${tarballs["@aotter/mantle"]}`,
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
  });
  const umbrella = join(temp, "umbrella-core/node_modules/@aotter/mantle");
  for (const doc of [
    "skills/install/SKILL.md",
    "skills/develop/SKILL.md",
    "skills/theme/SKILL.md",
    "docs/direct-authoring.md",
    "docs/transaction-patterns.md",
    "docs/handbook/navigation.json",
    "docs/handbook/start/overview.md",
    "docs/handbook/reference/features.md",
    "docs/handbook/guides/agent-setup.md",
    "docs/handbook/guides/typed-queries.md",
    "docs/handbook/guides/admin-ui.md",
    "docs/handbook/start/project-and-cli.md",
    "docs/handbook/start/quickstart-admin.md",
    "docs/handbook/reference/schema.md",
    "docs/examples/host-minimal-worker/package.json",
    "docs/examples/host-local-admin-otp/package.json",
    "docs/examples/host-local-admin-otp/.dev.vars.example",
    "docs/examples/README.md",
    "docs/examples/builtin-commerce.md",
  ]) {
    if (!existsSync(join(umbrella, doc))) throw new Error(`Packed authoring reference missing: ${doc}`);
  }
  const packedCli = join(umbrella, "dist/cli/main.js");
  const consumerRoot = join(temp, "umbrella-core");
  execFileSync(process.execPath, [packedCli, "skills"], { cwd: consumerRoot, stdio: "pipe" });
  execFileSync(process.execPath, [packedCli, "skills", "--check"], { cwd: consumerRoot, stdio: "pipe" });
  for (const skill of ["develop", "plugin", "theme", "update"]) {
    for (const agent of [".agents", ".claude"]) {
      const projected = readFileSync(join(consumerRoot, agent, "skills", `mantle-${skill}`, "SKILL.md"), "utf8");
      if (projected !== readFileSync(join(umbrella, "skills", skill, "SKILL.md"), "utf8")) {
        throw new Error(`Packed skill projection differs: ${agent}/${skill}`);
      }
    }
  }
  const adminOtpPkg = JSON.parse(readFileSync(join(umbrella, "docs/examples/host-local-admin-otp/package.json"), "utf8"));
  if (!String(adminOtpPkg.scripts?.dev ?? "").includes("--ip 127.0.0.1")) {
    throw new Error("Packed local-admin-otp pnpm dev must pin wrangler --ip 127.0.0.1");
  }
  const minimalPkg = JSON.parse(readFileSync(join(umbrella, "docs/examples/host-minimal-worker/package.json"), "utf8"));
  if (!String(minimalPkg.scripts?.dev ?? "").includes("--ip 127.0.0.1")) {
    throw new Error("Packed minimal-worker pnpm dev must pin wrangler --ip 127.0.0.1");
  }
  const packedManifest = JSON.parse(readFileSync(join(umbrella, "package.json"), "utf8"));
  if (packedManifest.exports["./provision"]) throw new Error("Retired provision export remains");
  if (!packedManifest.exports["./auth"]) throw new Error("Umbrella is missing the ./auth optional export");
  if (!packedManifest.peerDependenciesMeta?.["@aotter/mantle-auth"]?.optional) {
    throw new Error("Umbrella must list @aotter/mantle-auth as an optional peer");
  }
  const authPacked = JSON.parse(execFileSync("tar", ["-xOf", tarballs["@aotter/mantle-auth"], "package/package.json"], {
    encoding: "utf8",
  }));
  if (authPacked.name !== "@aotter/mantle-auth" || !authPacked.exports?.["."]) {
    throw new Error("Packed @aotter/mantle-auth manifest is incomplete");
  }
  const payload = execFileSync("tar", ["-tf", tarballs["@aotter/mantle"]], { encoding: "utf8" });
  const leaked = payload.split("\n").filter((entry) => {
    const name = entry.split("/").pop()?.replace(/\/$/, "") ?? "";
    if (!name || name.endsWith(".example")) return false;
    return /^(?:node_modules|\.wrangler|\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(name);
  });
  if (leaked.length > 0) {
    throw new Error(`Packed documentation contains local state: ${leaked.join(", ")}`);
  }
  for (const optional of [
    "mantle-web",
    "mantle-mcp",
    "mantle-admin",
    "mantle-admin-ui",
    "mantle-auth",
    "mantle-bun",
    "mantle-cloudflare",
    "mantle-indexeddb",
    "mantle-vercel",
  ]) {
    if (existsSync(join(temp, `umbrella-core/node_modules/@aotter/${optional}`))) {
      throw new Error(`umbrella Core consumer installed optional @aotter/${optional}`);
    }
  }

  installConsumer("core-with-web", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    "@aotter/mantle-web": `file:${tarballs["@aotter/mantle-web"]}`,
    zod,
  }, `
    await import("@aotter/mantle-runtime");
    const web = await import("@aotter/mantle-web");
    const webmcp = await import("@aotter/mantle-web/webmcp");
    if (typeof web.createMantleWeb !== "function") throw new Error("missing createMantleWeb");
    if (typeof webmcp.bindWebMcp !== "function") throw new Error("missing WebMCP subpath");
    const binding = await webmcp.bindWebMcp();
    if (binding.supported !== false) throw new Error("headless WebMCP feature detection failed");
  `);

  installConsumer("core-with-mcp", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    "@aotter/mantle-mcp": `file:${tarballs["@aotter/mantle-mcp"]}`,
    "@aotter/mantle-ui": `file:${tarballs["@aotter/mantle-ui"]}`,
    zod,
  }, `
    const spec = await import("@aotter/mantle-spec");
    const core = await import("@aotter/mantle-runtime");
    const mcp = await import("@aotter/mantle-mcp");
    const parsed = spec.parseManifestSources({ sources: [] });
    if (!parsed.ok) throw new Error("empty source set did not parse");
    const linked = spec.linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error("empty source set did not link");
    const compiled = core.compileRuntimePlan(linked.value);
    if (!compiled.ok) throw new Error("empty source set did not compile");
    const runtime = await core.bootMantleRuntime({
      plan: compiled.value,
      storage: { prepare: async () => ({ entries: {}, views: {}, localePolicy: {} }) },
    });
    const invoker = core.bindCapabilities(runtime, compiled.value, { surface: "public" });
    const handler = mcp.createMantleMcpHandler(invoker, { serverInfo: { name: "packed" } });
    const response = await handler.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "packed", version: "1" } },
      }),
    }), { user: null, staff: null, env: {} });
    const text = await response.text();
    if (response.status !== 200 || !text.includes('"serverInfo"')) {
      throw new Error("packed MCP handler did not answer initialize: " + response.status + " " + text);
    }
    // The built MCP App registers as a UI resource and is served whole.
    const { interactionAppResource, INTERACTION_APP_URI } = await import("@aotter/mantle-ui/mcp-app");
    const withApp = mcp.createMantleMcpHandler(invoker, { apps: { resources: [interactionAppResource()] } });
    const read = await withApp.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: INTERACTION_APP_URI } }),
    }), { user: null, staff: null, env: {} });
    const resource = await read.text();
    if (read.status !== 200 || !resource.includes("text/html;profile=mcp-app") || !resource.includes("<!doctype html>")) {
      throw new Error("packed MCP App resource was not served: " + read.status + " " + resource.slice(0, 200));
    }
  `);
  for (const forbidden of ["react", "@aotter/mantle-admin", "@aotter/mantle-web"]) {
    if (existsSync(join(temp, `core-with-mcp/node_modules/${forbidden}`))) {
      throw new Error(`MCP consumer installed ${forbidden}`);
    }
  }

  // The controller runs alone: its Mantle imports are type-only.
  installConsumer("ui-controller-only", {
    "@aotter/mantle-ui": `file:${tarballs["@aotter/mantle-ui"]}`,
  }, `
    const { createInteractionController } = await import("@aotter/mantle-ui/controller");
    const controller = createInteractionController({
      interaction: { bind: [{ input: "id", field: "id" }], version: "expectedVersion" },
      row: { id: "r1", version: 1 },
      read: async () => ({ id: "r1", version: 1, data: {} }),
      invoke: async (input) => ({ ok: true, data: input }),
    });
    await controller.open();
    await controller.submit();
    const { phase, result } = controller.getSnapshot();
    if (phase !== "succeeded" || result.expectedVersion !== 1) throw new Error("packed controller did not submit: " + phase);
  `);
  // The kit's libraries are optional peers: the controller pulls none of them.
  for (const forbidden of ["react", "@aotter/mantle-runtime", "@aotter/mantle-spec", "radix-ui", "lucide-react", "sonner"]) {
    if (existsSync(join(temp, `ui-controller-only/node_modules/${forbidden}`))) {
      throw new Error(`UI controller consumer installed ${forbidden}`);
    }
  }

  // The kit with its peers, as an application building its own auth page.
  const uiManifest = JSON.parse(readFileSync(join(root, "packages/mantle-ui/package.json"), "utf8"));
  const kitPeers = Object.fromEntries(Object.entries(uiManifest.peerDependencies).filter(([name]) => name !== "react"));
  installConsumer("ui-kit", {
    "@aotter/mantle-ui": `file:${tarballs["@aotter/mantle-ui"]}`,
    react: uiManifest.devDependencies.react,
    "react-dom": uiManifest.devDependencies["react-dom"],
    ...kitPeers,
  }, `
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const kit = await import("@aotter/mantle-ui/kit");
    const html = renderToStaticMarkup(createElement(kit.Card, null, createElement(kit.Button, null, "Continue")));
    if (!html.includes('data-slot="button"')) throw new Error("packed kit did not render");
    for (const sheet of ["@aotter/mantle-ui/kit.css", "@aotter/mantle-ui/tokens.css"]) {
      if (!existsSync(fileURLToPath(import.meta.resolve(sheet)))) throw new Error("packed kit is missing " + sheet);
    }
  `);

  installConsumer("core-with-indexeddb", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    "@aotter/mantle-indexeddb": `file:${tarballs["@aotter/mantle-indexeddb"]}`,
    zod,
  }, `
    const browser = await import("@aotter/mantle-indexeddb");
    const storage = new browser.IndexedDbMantleStorageAdapter({ databaseName: "packed" });
    if (storage.nativeViewDialects.length !== 0 ||
        typeof storage.prepare !== "function" ||
        typeof storage.deleteDatabase !== "function") {
      throw new Error("packed IndexedDB adapter surface is incomplete");
    }
  `);

  installConsumer("core-with-admin", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    // Admin's staff MCP depends on it; the tarball keeps the install offline.
    "@aotter/mantle-mcp": `file:${tarballs["@aotter/mantle-mcp"]}`,
    "@aotter/mantle-admin": `file:${tarballs["@aotter/mantle-admin"]}`,
    hono,
    zod,
  }, `
    const spec = await import("@aotter/mantle-spec");
    const core = await import("@aotter/mantle-runtime");
    const admin = await import("@aotter/mantle-admin");
    if (typeof admin.mountMantleAdmin !== "function") throw new Error("missing mountMantleAdmin");
    const { Hono } = await import("hono");
    const app = new Hono();
    const parsed = spec.parseManifestSources({ sources: [] });
    if (!parsed.ok) throw new Error("empty source set did not parse");
    const linked = spec.linkManifestSet(parsed.value);
    if (!linked.ok) throw new Error("empty source set did not link");
    const compiled = core.compileRuntimePlan(linked.value);
    if (!compiled.ok) throw new Error("empty source set did not compile");
    let role = "owner";
    admin.mountMantleAdmin(app, {
      plan: compiled.value,
      assets: { fetch: async () => new Response("admin shell") },
      auth: {
        basePath: "/api/auth",
        handler: async () => new Response(null, { status: 404 }),
        methods: [],
        getSession: async () => ({ session: { id: "session" }, user: { id: "user" } }),
        getUserRole: async () => role,
        listUsers: async () => [],
        listMembers: async () => ({ items: [], previousCursor: null, nextCursor: null }),
        setUserRole: async () => false,
        inviteUser: async () => ({ kind: "created", id: "invite" }),
        revokeInvite: async () => false,
      },
      get: async () => { throw new Error("runtime must stay lazy"); },
    });
    const shell = await app.request("https://example.test/admin");
    if (shell.status !== 200 || await shell.text() !== "admin shell") {
      throw new Error("Admin asset composition failed");
    }
    if ((await app.request("https://example.test/admin/api/me")).status !== 200) {
      throw new Error("Admin staff gate rejected an owner");
    }
    role = null;
    if ((await app.request("https://example.test/admin/api/me")).status !== 403) {
      throw new Error("Admin staff gate accepted a non-staff user");
    }
  `);

  if (existsSync(join(temp, "core-with-admin/node_modules/@aotter/mantle-admin-ui"))) {
    throw new Error("Admin API consumer installed the optional Admin UI");
  }

  console.log("Packed spec-only, Core-only, umbrella Core, Core+Web, Core+MCP, UI controller, UI kit, Core+IndexedDB, Core+Admin, and Auth packing consumers passed.");
} finally {
  rmSync(localState, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
}

function installConsumer(name, dependencies, check, overrides = dependencies) {
  const directory = join(temp, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    // Without this, corepack has nothing to pin against here and falls back to
    // whatever pnpm is globally installed; a pnpm major other than the repo's
    // silently ignores the pnpm.overrides below and resolves @aotter/* from the registry.
    packageManager: rootManifest.packageManager,
    dependencies,
    pnpm: {
      overrides: Object.fromEntries(
        Object.entries(overrides).filter(([name]) => name.startsWith("@aotter/")),
      ),
      peerDependencyRules: {
        allowAny: Object.keys(overrides).filter((name) => name.startsWith("@aotter/")),
      },
    },
  }, null, 2)}\n`);
  execFileSync("pnpm", ["install", "--ignore-scripts"], {
    cwd: directory,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["--input-type=module", "--eval", check], {
    cwd: directory,
    stdio: "inherit",
  });
}
