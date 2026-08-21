import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "../../src/cli/update.js";
import {
  PROVISION_BUNDLE_FORMAT_VERSION,
  PROVISION_BUNDLE_KIND,
} from "../../src/provision.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("mantle update", () => {
  it("reports source, target, and local drift without changing authored files", async () => {
    const bundles = new Map([
      ["/v1/blank.json", bundle("old")],
      ["/v2/blank.json", bundle("new", { "src/new.ts": "new\n" })],
    ]);
    const server = await serve((path) => bundles.get(path) ?? null);
    const root = await project({ sourceRef: "v1", targetRef: "v2", baseUrl: `${server.url}/{ref}` });
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "index.ts"), "local edit\n");
      await writeFile(join(root, "src", "custom.ts"), "custom\n");
      await writeFile(join(root, "package.json"), '{"name":"update-test"}\n');
      const before = await readFile(join(root, "src", "index.ts"), "utf8");
      process.chdir(root);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      expect(await runUpdate([])).toBe(0);

      const report = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(report.upstream.differing).toContainEqual(expect.objectContaining({ path: "src/index.ts" }));
      expect(report.upstream.missing_current).toContainEqual(expect.objectContaining({ path: "src/new.ts" }));
      expect(report.upstream.differing).not.toContainEqual(
        expect.objectContaining({ path: ".mantle/launch-state.json" }),
      );
      expect(report.local.differing).toContainEqual(expect.objectContaining({ path: "src/index.ts" }));
      expect(report.local.removed_upstream).toContainEqual(expect.objectContaining({ path: "src/custom.ts" }));
      expect(report.metadata_migration).toMatchObject({
        required: true,
        files: [
          { path: ".mantle/launch-state.json", set: { starter_ref: "v2" } },
          { path: ".mantle/features.json", set: { "registry.version": "v2" } },
        ],
      });
      expect(await readFile(join(root, "src", "index.ts"), "utf8")).toBe(before);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bridges the alpha.63 no-v ref and reproduces legacy project identity", async () => {
    const requested: string[] = [];
    const source = JSON.stringify({
      version: "0.0.11-alpha.63",
      archetype: "blank",
      files: {
        "src/index.ts": "old\n",
        ".dev.vars.example": [
          "ADMIN_GITHUB_LOGIN={{ADMIN_GITHUB_LOGIN}}",
          "MANTLE_SITE_OWNER_EMAIL={{SITE_OWNER_EMAIL}}",
          "",
        ].join("\n"),
        "wrangler.toml": legacyWrangler("mantle-blank", "mantle-blank-local"),
      },
    });
    const target = bundle("new");
    const server = await serve((path) => {
      requested.push(path);
      if (path === "/0.0.11-alpha.63/blank.json") return null;
      if (path === "/v0.0.11-alpha.63/blank.json") return source;
      if (path === "/v0.0.11-alpha.64/blank.json") return target;
      return null;
    });
    const root = await project({ sourceRef: "0.0.11-alpha.63", targetRef: "v0.0.11-alpha.64" });
    try {
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "index.ts"), "old\n");
      await writeFile(
        join(root, ".dev.vars.example"),
        "ADMIN_GITHUB_LOGIN=\nMANTLE_SITE_OWNER_EMAIL=\n",
      );
      await writeFile(
        join(root, "wrangler.toml"),
        legacyWrangler("update-test", "update-test-db", "https://update.example", "0xpublic"),
      );
      const launchPath = join(root, ".mantle", "launch-state.json");
      const launch = JSON.parse(await readFile(launchPath, "utf8"));
      await writeFile(launchPath, JSON.stringify({
        ...launch,
        site_url: "https://update.example",
        github: { owner: "", admin_login: "" },
      }));
      process.chdir(root);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      expect(await runUpdate([
        "--bundle-base-url", `${server.url}/{ref}`,
        "--ref", "v0.0.11-alpha.64",
      ])).toBe(0);

      const report = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(requested).toContain("/0.0.11-alpha.63/blank.json");
      expect(requested).toContain("/v0.0.11-alpha.63/blank.json");
      expect(report.local.differing).not.toContainEqual(expect.objectContaining({ path: "wrangler.toml" }));
      expect(report.local.differing).not.toContainEqual(expect.objectContaining({ path: ".dev.vars.example" }));
      expect(report.metadata_migration.files[1].set).toEqual({
        "registry.version": "v0.0.11-alpha.64",
        "registry.bundleBaseUrl": `${server.url}/{ref}`,
      });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes format-versioned bundles through the shared renderer", async () => {
    const server = await serve(() => JSON.stringify({
      formatVersion: PROVISION_BUNDLE_FORMAT_VERSION,
      kind: PROVISION_BUNDLE_KIND,
      version: "current",
      archetype: "blank",
      files: { "README.md": "# {{BRAND}}\n" },
      binaryFiles: { "public/icon.png": "aGVsbG8=" },
    }));
    const root = await project({ sourceRef: "current", targetRef: "current", baseUrl: `${server.url}/{ref}` });
    try {
      await mkdir(join(root, "public"));
      await writeFile(join(root, "README.md"), "# update-test\n");
      await writeFile(join(root, "public", "icon.png"), Buffer.from("hello"));
      process.chdir(root);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      expect(await runUpdate([])).toBe(0);

      const report = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(report.upstream.counts).toEqual({ differing: 0, missing_current: 0, removed_upstream: 0 });
      expect(report.local.counts).toEqual({ differing: 0, missing_current: 0, removed_upstream: 0 });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails clearly on unknown placeholders, path escapes, and missing refs", async () => {
    const server = await serve((path) => {
      if (path.startsWith("/unknown/")) return JSON.stringify({ files: { "src/index.ts": "{{UNKNOWN}}" } });
      if (path.startsWith("/escape/")) return JSON.stringify({ files: { "../escape": "bad" } });
      if (path.startsWith("/current-invalid/")) return JSON.stringify({
        formatVersion: PROVISION_BUNDLE_FORMAT_VERSION,
        kind: PROVISION_BUNDLE_KIND,
        version: "current-invalid",
        archetype: "blank",
      });
      return null;
    });
    const root = await project({ sourceRef: "unknown", targetRef: "unknown", baseUrl: `${server.url}/{ref}` });
    try {
      process.chdir(root);
      let output = "";
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
      for (const [ref, message] of [
        ["unknown", "unknown provision placeholder"],
        ["escape", "bundle path has an empty, dot, or parent segment"],
        ["current-invalid", "bundle files are missing"],
        ["missing", "HTTP 404"],
      ]) {
        await setRefs(root, ref);
        output = "";
        expect(await runUpdate([])).toBe(1);
        expect(output).toContain(message);
      }
      await expect(readFile(join(root, ".mantle", "update-report.json"))).rejects.toThrow();
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to follow an update-report symlink", async () => {
    const server = await serve(() => bundle("same"));
    const root = await project({ sourceRef: "same", targetRef: "same", baseUrl: `${server.url}/{ref}` });
    const outside = join(root, "outside.txt");
    try {
      await writeFile(outside, "keep\n");
      await symlink(outside, join(root, ".mantle", "update-report.json"));
      process.chdir(root);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runUpdate([])).toBe(1);
      expect(await readFile(outside, "utf8")).toBe("keep\n");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function serve(bodyFor: (path: string) => string | null) {
  const server = createServer((request, response) => {
    const body = bodyFor(request.url ?? "");
    response.writeHead(body === null ? 404 : 200, { "content-type": body === null ? "text/plain" : "application/json" });
    response.end(body ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

async function project(input: { sourceRef: string; targetRef: string; baseUrl?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mantle-update-"));
  await mkdir(join(root, ".mantle"));
  await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
    project_name: "update-test",
    archetype: "blank",
    starter_ref: input.sourceRef,
    locales: ["en"],
  }));
  await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
    registry: { version: input.targetRef, ...(input.baseUrl ? { bundleBaseUrl: input.baseUrl } : {}) },
  }));
  return root;
}

async function setRefs(root: string, ref: string): Promise<void> {
  const launchPath = join(root, ".mantle", "launch-state.json");
  const featuresPath = join(root, ".mantle", "features.json");
  await writeFile(launchPath, JSON.stringify({ ...JSON.parse(await readFile(launchPath, "utf8")), starter_ref: ref }));
  await writeFile(featuresPath, JSON.stringify({
    registry: {
      version: ref,
      bundleBaseUrl: JSON.parse(await readFile(featuresPath, "utf8")).registry.bundleBaseUrl,
    },
  }));
}

function bundle(value: string, extra: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify({
    kind: PROVISION_BUNDLE_KIND,
    archetype: "blank",
    version: value,
    files: {
      "src/index.ts": `${value}\n`,
      "package.json": '{"name":"{{PROJECT_NAME}}"}\n',
      ".mantle/launch-state.json.template": '{"starter_ref":"{{STARTER_REF}}"}\n',
      ".mantle/features.json.template": '{"resolvedAt":"{{INSTALL_TIMESTAMP}}"}\n',
      ...extra,
    },
  });
}

function legacyWrangler(
  project: string,
  database: string,
  origin = "http://localhost:8787",
  turnstile = "",
): string {
  return `name = ${JSON.stringify(project)}

[[d1_databases]]
binding = "DB"
database_name = ${JSON.stringify(database)}

[vars]
PUBLIC_ORIGIN = ${JSON.stringify(origin)}
${turnstile ? "" : "# "}TURNSTILE_SITE_KEY = ${JSON.stringify(turnstile)}
`;
}
