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
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "mantle-optional-packages-"));
const artifacts = join(temp, "artifacts");
const zod = `file:${realpathSync(join(root, "packages/mantle-runtime/node_modules/zod"))}`;
const hono = `file:${realpathSync(join(root, "packages/adapters/cloudflare/node_modules/hono"))}`;

try {
  mkdirSync(artifacts);
  const tarballs = Object.fromEntries([
    ["@aotter/mantle", "packages/mantle"],
    ["@aotter/mantle-spec", "packages/mantle-spec"],
    ["@aotter/mantle-runtime", "packages/mantle-runtime"],
    ["@aotter/mantle-web", "packages/mantle-web"],
    ["@aotter/mantle-admin-ui", "packages/mantle-admin-ui"],
    ["@aotter/mantle-admin", "packages/mantle-admin"],
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
    "mantle-admin",
    "mantle-admin-ui",
    "mantle-bun",
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
  for (const optional of [
    "mantle-web",
    "mantle-admin",
    "mantle-admin-ui",
    "mantle-bun",
    "mantle-cloudflare",
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

  installConsumer("core-with-admin", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
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

  console.log("Packed spec-only, Core-only, umbrella Core, Core+Web, and Core+Admin consumers passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function installConsumer(name, dependencies, check, overrides = dependencies) {
  const directory = join(temp, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies,
    pnpm: {
      overrides: Object.fromEntries(
        Object.entries(overrides).filter(([name]) => name.startsWith("@aotter/")),
      ),
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
