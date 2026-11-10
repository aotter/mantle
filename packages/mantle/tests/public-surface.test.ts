import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateFromSources } from "../src/infrastructure/generate.js";
import { loadFixtureSources } from "./apps/link.js";

/**
 * Every subpath of the exports map belongs to exactly one class (#1971). Adding a subpath means adding it here, which is
 * the decision to make: a name in DEVELOPER or HOST is a compatibility promise, a name under `./internal/` is not.
 */
/** Developer API: documented in the handbook or skills, or imported by hand-written application code. */
const DEVELOPER = [
  ".",
  "./generate",
  "./generate/auth",
  "./package.json",
  "./contracts",
  "./rest",
  "./mcp",
  "./mcp/apps",
  "./web",
  "./site",
  "./media",
  "./media/r2",
  "./email",
  "./cron",
  "./testing",
  "./auth",
  "./auth/adapter",
  "./auth/oauth",
  "./auth/routes",
  "./auth/identity",
  "./auth/hardening",
  "./auth/admin",
  "./bun/assets",
  // The SQLite `Handle` contracts an application names for its database; generated code imports the same modules.
  "./driver/d1",
  "./driver/bun-sqlite",
];
/** Host platform contract: versioned, consumed across applications running different core versions. Names and paths stay. */
const HOST = ["./host-caller", "./host-access", "./describe"];
/** Generated-code plumbing: imported by `mantle generate` output, regenerated with the SDK, no compatibility promise. */
const INTERNAL = "./internal/";

const root = resolve(import.meta.dir, "../../..");
const subpaths = async () =>
  Object.keys(JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8")).exports as object);

test("every exported subpath is classified as developer API, host contract or internal plumbing", async () => {
  const exported = await subpaths();
  const classified = [...DEVELOPER, ...HOST];
  expect(new Set(classified).size).toBe(classified.length);
  expect(classified.filter(name => name.startsWith(INTERNAL))).toEqual([]);
  expect(exported.filter(name => !name.startsWith(INTERNAL) && !classified.includes(name))).toEqual([]);
  expect(classified.filter(name => !exported.includes(name))).toEqual([]);
});

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter(entry => entry.name !== "node_modules" && entry.name !== "generated" && entry.name !== "dist")
      .map(entry => (entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])),
  );
  return nested.flat();
}

test("the handbook, skills and hand-written examples never name internal plumbing", async () => {
  const internal = (await subpaths())
    .filter(name => name.startsWith(INTERNAL))
    .map(name => name.slice(INTERNAL.length));
  // Both spellings: the namespace itself, and the path a plumbing module had before it moved.
  const plumbing = new RegExp(`@aotter/mantle/(?:internal/|(?:${internal.join("|")})(?![\\w/-]))`);
  const documents = (
    await Promise.all(["docs/handbook", "docs/examples", "skills"].map(directory => files(join(root, directory))))
  )
    .flat()
    .filter(file => /\.(?:md|ts|tsx|mjs|json)$/.test(file) && !file.includes("/docs/handbook/releases/"));
  const named: string[] = [];
  for (const file of documents)
    if (plumbing.test(await readFile(file, "utf8"))) named.push(file.slice(root.length + 1));
  expect(named).toEqual([]);
});

test.each(["bun-sqlite", "bun-postgres", "cloudflare-d1", "cloudflare-postgres"] as const)(
  "%s output imports only exported subpaths",
  async target => {
    const exported = new Set(await subpaths());
    const generated = await generateFromSources({ target, sources: { sources: await loadFixtureSources() } });
    if (!generated.ok) throw Error(JSON.stringify(generated.diagnostics));
    const imported = new Set<string>();
    for (const source of Object.values(generated.files))
      for (const [, path] of source.matchAll(/["']@aotter\/mantle\/([^"']+)["']/g)) imported.add(`./${path}`);
    expect(imported.size).toBeGreaterThan(3);
    expect([...imported].filter(name => !exported.has(name))).toEqual([]);
  },
);
