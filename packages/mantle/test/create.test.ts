import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVISION_BUNDLE_KIND } from "../src/provision.js";
import { runCreate } from "../src/create.js";

const BUNDLE = {
  kind: PROVISION_BUNDLE_KIND,
  version: "0.1.0-alpha.7",
  archetype: "blank",
  files: {
    "README.md": "# {{BRAND}}\n",
    "wrangler.toml": 'name = "mantle-blank"\n\n[vars]\nMANTLE_AUTH_MODE = "{{AUTH_MODE}}"\n',
    ".mantle/launch-state.json.template": '{"project_name":"{{PROJECT_NAME}}","locales":{{LOCALES}}}\n',
  },
  binaryFiles: { "public/icon.png": "aGVsbG8=" },
};

let workspace: string;
const requested: string[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "mantle-create-test-"));
  requested.length = 0;
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

function stubFetch(body: unknown, ok = true, streamed = false): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(String(url));
    return {
      ok,
      status: ok ? 200 : 404,
      headers: new Headers(),
      // The real fetch always exposes a stream; exercise that path too.
      body: streamed
        ? new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = new TextEncoder().encode(payload);
            controller.enqueue(bytes.slice(0, 5));
            controller.enqueue(bytes.slice(5));
            controller.close();
          },
        })
        : null,
      text: async () => payload,
    } as unknown as Response;
  });
}

describe("mantle create", () => {
  it("rejects an unknown starter type without touching the filesystem", async () => {
    stubFetch(BUNDLE);
    expect(await runCreate(["nope", join(workspace, "site")])).toBe(2);
    expect(requested).toEqual([]);
    await expect(stat(join(workspace, "site"))).rejects.toThrow();
  });

  it("requires exactly a type and a directory", async () => {
    expect(await runCreate(["blank"])).toBe(2);
    expect(await runCreate([])).toBe(2);
  });

  it("resolves only the official immutable tag for this package version", async () => {
    stubFetch(BUNDLE);
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(await runCreate(["blank", join(workspace, "site")])).toBe(0);
    expect(requested).toEqual([
      `https://raw.githubusercontent.com/aotter/mantle-starters/v${version}/provision-bundles/blank.json`,
    ]);
  });

  it("materializes text and binary files with fixed modes", async () => {
    stubFetch(BUNDLE);
    const target = join(workspace, "morning-lab");
    expect(await runCreate(["blank", target])).toBe(0);

    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# Morning Lab\n");
    expect(await readFile(join(target, "public/icon.png"), "utf8")).toBe("hello");
    expect(JSON.parse(await readFile(join(target, ".mantle/launch-state.json"), "utf8"))).toEqual({
      project_name: "morning-lab",
      locales: ["en"],
    });
    expect(await readFile(join(target, "wrangler.toml"), "utf8")).toContain('name = "morning-lab"');

    const mode = (await stat(join(target, "README.md"))).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("honours brand, description, and locales", async () => {
    stubFetch(BUNDLE);
    const target = join(workspace, "shop");
    expect(await runCreate([
      "blank", target, "--brand", "Aotter Shop", "--description", "Catalog.", "--locales", "en,ja",
    ])).toBe(0);
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# Aotter Shop\n");
    expect(JSON.parse(await readFile(join(target, ".mantle/launch-state.json"), "utf8")).locales)
      .toEqual(["en", "ja"]);
  });

  it("reads a streamed response body", async () => {
    stubFetch(BUNDLE, true, true);
    const target = join(workspace, "streamed");
    expect(await runCreate(["blank", target])).toBe(0);
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# Streamed\n");
  });

  it("refuses a missing parent rather than inventing directories", async () => {
    stubFetch(BUNDLE);
    expect(await runCreate(["blank", join(workspace, "a", "b", "site")])).toBe(1);
    expect(await readdir(workspace)).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("refuses an existing target and leaves it untouched", async () => {
    stubFetch(BUNDLE);
    const target = join(workspace, "taken");
    await writeFile(target, "keep me");
    expect(await runCreate(["blank", target])).toBe(1);
    expect(await readFile(target, "utf8")).toBe("keep me");
    expect(requested).toEqual([]);
  });

  it("leaves nothing behind when the bundle cannot be fetched", async () => {
    stubFetch("nope", false);
    expect(await runCreate(["blank", join(workspace, "site")])).toBe(1);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("leaves nothing behind when the bundle fails to render", async () => {
    stubFetch({ ...BUNDLE, archetype: "presence" });
    expect(await runCreate(["blank", join(workspace, "site")])).toBe(1);
    expect(await readdir(workspace)).toEqual([]);
  });

  it("leaves nothing behind when the bundle is not JSON", async () => {
    stubFetch("<html>404</html>");
    expect(await runCreate(["blank", join(workspace, "site")])).toBe(1);
    expect(await readdir(workspace)).toEqual([]);
  });
});
