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

  installConsumer("core-only", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    zod,
  }, `
    await import("@aotter/mantle-runtime");
  `);
  for (const optional of ["mantle-web", "mantle-admin", "mantle-admin-ui"]) {
    if (existsSync(join(temp, `core-only/node_modules/@aotter/${optional}`))) {
      throw new Error(`core-only consumer installed @aotter/${optional}`);
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
    if (typeof web.createMantleWeb !== "function") throw new Error("missing createMantleWeb");
  `);

  installConsumer("core-with-admin", {
    "@aotter/mantle-spec": `file:${tarballs["@aotter/mantle-spec"]}`,
    "@aotter/mantle-runtime": `file:${tarballs["@aotter/mantle-runtime"]}`,
    "@aotter/mantle-admin-ui": `file:${tarballs["@aotter/mantle-admin-ui"]}`,
    "@aotter/mantle-admin": `file:${tarballs["@aotter/mantle-admin"]}`,
    hono,
    zod,
  }, `
    await import("@aotter/mantle-runtime");
    const admin = await import("@aotter/mantle-admin");
    if (typeof admin.mountMantleAdmin !== "function") throw new Error("missing mountMantleAdmin");
    const { Hono } = await import("hono");
    const app = new Hono();
    let role = "owner";
    admin.mountMantleAdmin(app, {
      manifests: [],
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

  console.log("Packed Core-only, Core+Web, and Core+Admin consumers passed.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function installConsumer(name, dependencies, check) {
  const directory = join(temp, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies,
    pnpm: {
      overrides: Object.fromEntries(
        Object.entries(dependencies).filter(([name]) => name.startsWith("@aotter/")),
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
