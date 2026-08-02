import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpdate } from "../src/update.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("mantle update", () => {
  it("uses the configured bundle source and reports upstream and local-only files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-update-test-"));
    const bundles = new Map([
      ["/v1/provision-bundles/blank.json", bundle("old")],
      ["/v2/provision-bundles/blank.json", bundle("new", { "src/new.ts": "export {};\n" })],
    ]);
    const server = createServer((request, response) => {
      const body = bundles.get(request.url ?? "");
      response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      response.end(body ?? "not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    try {
      await mkdir(join(root, ".mantle"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
        project_name: "update-test",
        archetype: "blank",
        starter_ref: "v1",
        locales: ["en"],
        brand: 'A & <"Site">',
        description: 'Line "one" \\ two',
      }));
      await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
        registry: {
          version: "v2",
          bundleBaseUrl: `http://127.0.0.1:${address.port}/{ref}/provision-bundles`,
        },
      }));
      await writeFile(join(root, "src", "index.ts"), "local edit\n");
      await writeFile(join(root, "src", "custom.ts"), "export const custom = true;\n");
      await writeFile(join(root, "public", "index.html"), "<h1>A &amp; &lt;&quot;Site&quot;&gt;</h1>\n");
      await writeFile(join(root, "package.json"), `${JSON.stringify({ description: 'Line "one" \\ two' })}\n`);
      await writeFile(join(root, "wrangler.jsonc"), materializedWrangler({
        projectName: "update-test",
        siteUrl: "https://example.com",
        brand: 'A & <"Site">',
        description: 'Line "one" \\ two',
        locales: ["en"],
      }));
      process.chdir(root);

      expect(await runUpdate([])).toBe(0);

      const report = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(report.source_ref).toBe("v1");
      expect(report.target_ref).toBe("v2");
      expect(report.upstream.differing.map(({ path }: { path: string }) => path)).toContain("src/index.ts");
      expect(report.upstream.missing_current.map(({ path }: { path: string }) => path)).toContain("src/new.ts");
      expect(report.local.differing.map(({ path }: { path: string }) => path)).toContain("src/index.ts");
      expect(report.local.differing.map(({ path }: { path: string }) => path)).not.toContain("public/index.html");
      expect(report.local.differing.map(({ path }: { path: string }) => path)).not.toContain("package.json");
      expect(report.local.differing.map(({ path }: { path: string }) => path)).not.toContain("wrangler.jsonc");
      expect(report.local.removed_upstream.map(({ path }: { path: string }) => path)).toContain("src/custom.ts");

      expect(await runUpdate([])).toBe(0);
      const rerun = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(rerun.local.removed_upstream.map(({ path }: { path: string }) => path))
        .not.toContain(".mantle/update-report.json");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a custom nested report on strict reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-update-custom-report-test-"));
    const body = bundle("same");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    try {
      await mkdir(join(root, ".mantle"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "public"), { recursive: true });
      await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
        project_name: "clean-site",
        archetype: "blank",
        starter_ref: "v1",
      }));
      await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
        registry: {
          version: "v1",
          bundleBaseUrl: `http://127.0.0.1:${address.port}/{ref}/provision-bundles`,
        },
      }));
      await writeFile(join(root, "src", "index.ts"), "same\n");
      await writeFile(join(root, "public", "index.html"), "<h1>clean-site</h1>\n");
      await writeFile(join(root, "package.json"), '{"description":"clean-site site."}\n');
      await writeFile(join(root, "wrangler.jsonc"), materializedWrangler({
        projectName: "clean-site",
        siteUrl: "https://example.com",
        brand: "clean-site",
        description: "clean-site site.",
        locales: ["en"],
      }));
      process.chdir(root);
      const args = ["--report", ".mantle/reports/custom.json", "--strict"];

      expect(await runUpdate(args)).toBe(0);
      expect(await runUpdate(args)).toBe(0);

      const report = JSON.parse(
        await readFile(join(root, ".mantle", "reports", "custom.json"), "utf8"),
      );
      expect(report.local.removed_upstream).not.toContainEqual(
        expect.objectContaining({ path: ".mantle/reports/custom.json" }),
      );
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects bundle paths outside the temporary project", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-update-escape-test-"));
    const body = JSON.stringify({ files: { "../escape": "bad" } });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    try {
      await mkdir(join(root, ".mantle"), { recursive: true });
      await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
        project_name: "escape-test",
        archetype: "blank",
        starter_ref: "v1",
      }));
      await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
        registry: {
          version: "v1",
          bundleBaseUrl: `http://127.0.0.1:${address.port}/{ref}`,
        },
      }));
      process.chdir(root);
      expect(await runUpdate([])).toBe(1);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports alpha.63 metadata when the old site supplies the bundle source override", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-update-legacy-test-"));
    const requested: string[] = [];
    const server = createServer((request, response) => {
      requested.push(request.url ?? "");
      if (request.url?.startsWith("/0.0.11-alpha.63/")) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("tag requires v prefix");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(bundle("legacy"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    try {
      await mkdir(join(root, ".mantle"), { recursive: true });
      await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
        project_name: "legacy-site",
        archetype: "blank",
        starter_ref: "0.0.11-alpha.63",
      }));
      await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
        registry: { version: "v0.0.11-alpha.64" },
      }));
      process.chdir(root);

      const base = `http://127.0.0.1:${address.port}/{ref}/provision-bundles`;
      expect(await runUpdate(["--bundle-base-url", base])).toBe(0);
      const report = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(report.source_ref).toBe("0.0.11-alpha.63");
      expect(report.target_ref).toBe("v0.0.11-alpha.64");
      expect(report.bundle_base_url).toBe(base);
      expect(requested).toContain("/0.0.11-alpha.63/provision-bundles/blank.json");
      expect(requested).toContain("/v0.0.11-alpha.63/provision-bundles/blank.json");
      expect(report.metadata_migration).toMatchObject({
        required: true,
        apply_after_reviewed_port: true,
        files: [
          { path: ".mantle/launch-state.json", set: { starter_ref: "v0.0.11-alpha.64" } },
          {
            path: ".mantle/features.json",
            set: { registry: { version: "v0.0.11-alpha.64", bundleBaseUrl: base } },
          },
        ],
      });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the provisioned identity in an alpha.63 Wrangler TOML source", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-update-alpha63-toml-test-"));
    const body = JSON.stringify({
      version: "v0.0.11-alpha.63",
      files: { "wrangler.toml": legacyWranglerToml("mantle-blank", "mantle-blank-local") },
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    try {
      await mkdir(join(root, ".mantle"), { recursive: true });
      await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
        project_name: "legacy-site",
        archetype: "presence",
        starter_ref: "v0.0.11-alpha.63",
        site_url: "https://legacy.example",
        brand: "Legacy Site",
        description: "Legacy description",
        locales: ["en", "zh-TW"],
      }));
      await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
        registry: {
          version: "v0.0.11-alpha.63",
          bundleBaseUrl: `http://127.0.0.1:${address.port}/{ref}/provision-bundles`,
        },
      }));
      await writeFile(
        join(root, "wrangler.toml"),
        legacyWranglerToml("legacy-site", "legacy-site-db", {
          siteUrl: "https://legacy.example",
          turnstileSiteKey: "0xlegacy",
        }),
      );
      process.chdir(root);

      expect(await runUpdate([])).toBe(0);
      const report = JSON.parse(await readFile(join(root, ".mantle", "update-report.json"), "utf8"));
      expect(report.local.differing).not.toContainEqual(
        expect.objectContaining({ path: "wrangler.toml" }),
      );
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compares presence and intake bundles with a public Turnstile placeholder", async () => {
    const body = bundle("turnstile", {
      "public/index.html": '<div class="cf-turnstile" data-sitekey="{{TURNSTILE_SITE_KEY}}"></div>\n',
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    try {
      for (const archetype of ["presence", "intake"]) {
        const root = await mkdtemp(join(tmpdir(), `mantle-update-${archetype}-test-`));
        try {
          await mkdir(join(root, ".mantle"), { recursive: true });
          await writeFile(join(root, ".mantle", "launch-state.json"), JSON.stringify({
            project_name: `${archetype}-site`,
            archetype,
            starter_ref: "v1",
            turnstile_site_key: "public-widget-key",
          }));
          await writeFile(join(root, ".mantle", "features.json"), JSON.stringify({
            registry: {
              version: "v2",
              bundleBaseUrl: `http://127.0.0.1:${address.port}/{ref}/provision-bundles`,
            },
          }));
          await mkdir(join(root, "public"), { recursive: true });
          await writeFile(
            join(root, "public", "index.html"),
            '<div class="cf-turnstile" data-sitekey="public-widget-key"></div>\n',
          );
          process.chdir(root);
          expect(await runUpdate([])).toBe(0);
          const report = JSON.parse(
            await readFile(join(root, ".mantle", "update-report.json"), "utf8"),
          );
          expect(report).toMatchObject({ source_ref: "v1", target_ref: "v2" });
          expect(report.local.differing).not.toContainEqual(
            expect.objectContaining({ path: "public/index.html" }),
          );
        } finally {
          process.chdir(originalCwd);
          await rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      server.close();
    }
  });
});

function bundle(index: string, extra: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify({
    version: index,
    files: {
      "src/index.ts": `${index}\n`,
      "public/index.html": "<h1>{{BRAND}}</h1>\n",
      "package.json": '{"description":"{{DESCRIPTION}}"}\n',
      "wrangler.jsonc": wranglerTemplate(),
      ...extra,
    },
  });
}

function wranglerTemplate(): string {
  return JSON.stringify({
    name: "{{PROJECT_NAME}}",
    vars: {
      PUBLIC_ORIGIN: "{{SITE_URL}}",
      MANTLE_SITE_BRAND: "{{BRAND}}",
      MANTLE_SITE_DESCRIPTION: "{{DESCRIPTION}}",
      MANTLE_SITE_LOCALES: "__MANTLE_LOCALES__",
    },
    d1_databases: [{ binding: "DB", database_name: "{{PROJECT_NAME}}-db" }],
  }, null, 2).replace('"__MANTLE_LOCALES__"', "{{LOCALES}}");
}

function materializedWrangler(args: {
  readonly projectName: string;
  readonly siteUrl: string;
  readonly brand: string;
  readonly description: string;
  readonly locales: readonly string[];
}): string {
  return JSON.stringify({
    name: args.projectName,
    vars: {
      PUBLIC_ORIGIN: args.siteUrl,
      MANTLE_SITE_BRAND: args.brand,
      MANTLE_SITE_DESCRIPTION: args.description,
      MANTLE_SITE_LOCALES: "__MANTLE_LOCALES__",
    },
    d1_databases: [{ binding: "DB", database_name: `${args.projectName}-db` }],
  }, null, 2).replace('"__MANTLE_LOCALES__"', JSON.stringify(args.locales));
}

function legacyWranglerToml(
  projectName: string,
  databaseName: string,
  values: {
    readonly siteUrl?: string;
    readonly turnstileSiteKey?: string;
  } = {},
): string {
  return `name = ${JSON.stringify(projectName)}

[[d1_databases]]
binding = "DB"
database_name = ${JSON.stringify(databaseName)}

[vars]
PUBLIC_ORIGIN = ${JSON.stringify(values.siteUrl ?? "http://localhost:8787")}
${values.turnstileSiteKey ? "" : "# "}TURNSTILE_SITE_KEY = ${JSON.stringify(values.turnstileSiteKey ?? "")}
`;
}
