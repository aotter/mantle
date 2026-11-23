import { expect, spyOn, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundle, pruneUnreachable } from "../src/infrastructure/bundle.js";

/**
 * A package like Admin's MCP module: one export dynamically imports a large card, another a fetch helper, a third a
 * locale chosen at run time; a second, unrelated `import()` in dead code shares a module with a live one.
 */
async function build(worker: string) {
  const dir = await mkdtemp(join(tmpdir(), "mantle-bundle-prune-"));
  const lib = join(dir, "node_modules/lib");
  await mkdir(join(lib, "locale"), { recursive: true });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "lib", type: "module", sideEffects: ["./side.js"], exports: "./index.js" }),
    "index.js": [
      "export const plain = 1;",
      'export const card = async () => (await import("./card.js")).default;',
      'export const fetchImage = async () => (await import("./fetch.js")).fetchImage();',
      "export const locale = async name => (await import(`./locale/${name}.js`)).default;",
      'export const report = async () => (await import("./report.js")).report();',
      'export const unusedReport = async () => (await import("./dead-report.js")).report();',
    ].join("\n"),
    "card.js": `export default "card:${"x".repeat(2000)}";`,
    "fetch.js": 'import "./side.js";\nexport const fetchImage = () => "fetched:" + globalThis.sideEffect;',
    "side.js": 'globalThis.sideEffect = "ran";',
    "locale/en.js": 'export default "hello";',
    "locale/fr.js": 'export default "bonjour";',
    "shared.js": `export const shared = name => name + ":${"s".repeat(2000)}";`,
    "report.js": 'import { shared } from "./shared.js";\nexport const report = () => shared("report");',
    "dead-report.js": 'import { shared } from "./shared.js";\nexport const report = () => shared("dead");',
  };
  for (const [name, source] of Object.entries(files)) await writeFile(join(lib, name), source);
  const entry = join(dir, "worker.js");
  await writeFile(entry, worker);
  const out = join(dir, "dist/worker");
  const metafile = await bundle(entry, out);
  const emitted = (readdirSync(out, { recursive: true }) as string[]).filter(name => name.endsWith(".js")).sort();
  const listed = Object.keys(metafile.outputs)
    .map(name => name.slice(name.lastIndexOf("dist/worker/") + "dist/worker/".length))
    .sort();
  // the returned metafile names exactly what is uploaded
  expect(listed).toEqual(emitted);
  const chunks = emitted.filter(name => name.startsWith("chunks/")).map(name => name.replace(/-[A-Z0-9]+\.js$/, ""));
  return { chunks, worker: await import(pathToFileURL(join(out, "worker.js")).href) };
}

test("a bundle uploads no chunk that only tree-shaken code imported, and names what it removed", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const { chunks, worker } = await build('import { plain } from "lib";\nexport default { fetch: () => plain };');
  const removed = log.mock.calls.map(args => String(args[0])).filter(line => line.startsWith("Removed "));
  log.mockRestore();
  expect(chunks).toEqual([]);
  expect(removed).toHaveLength(1);
  expect(removed[0]).toMatch(/^Removed \d+ chunk\(s\) \(\d+ B\) no import from the entry reaches: /);
  for (const name of ["card-", "fetch-", "report-", "dead-report-", "en-", "fr-"]) expect(removed[0]).toContain(name);
  expect(worker.default.fetch()).toBe(1);
});

test("chunks an app can import at run time stay and load, including shared, side-effect, re-exported and computed ones", async () => {
  const { chunks, worker } = await build(
    [
      'import { fetchImage, locale, report } from "lib";',
      // the card reached only through a re-export of the entry
      'export { card } from "lib";',
      "export default { fetchImage, locale, report };",
    ].join("\n"),
  );
  // dead-report is gone; report and the module it shares with dead-report remain
  expect(chunks).not.toContain("chunks/dead-report");
  expect(chunks).toEqual(
    expect.arrayContaining(["chunks/card", "chunks/fetch", "chunks/en", "chunks/fr", "chunks/report"]),
  );
  expect(await worker.card()).toStartWith("card:");
  expect(await worker.default.fetchImage()).toBe("fetched:ran");
  expect(await worker.default.locale("fr")).toBe("bonjour");
  expect(await worker.default.report()).toStartWith("report:");
});

test("an import graph pruning cannot read fails the build and deletes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-bundle-prune-"));
  const entry = join(dir, "worker.ts"),
    out = join(dir, "out");
  await mkdir(join(out, "chunks"), { recursive: true });
  for (const name of ["worker.js", "chunks/a.js", "chunks/b.js"]) await writeFile(join(out, name), "");
  const output = (imports: string[], entryPoint?: string) => ({
    bytes: 1,
    inputs: {},
    imports: imports.map(path => ({ path, kind: "dynamic-import" as const })),
    exports: [],
    ...(entryPoint ? { entryPoint } : {}),
  });
  const metafile = (outputs: Record<string, ReturnType<typeof output>>) => ({ inputs: {}, outputs });
  // an import of an output the metafile does not list
  expect(() =>
    pruneUnreachable(
      metafile({
        [join(out, "worker.js")]: output([join(out, "chunks/gone.js")], entry),
        [join(out, "chunks/a.js")]: output([]),
      }),
      entry,
    ),
  ).toThrow(
    /chunks\/gone\.js, which esbuild's metafile does not list[\s\S]*Nothing was removed[\s\S]*esbuild version @aotter\/mantle depends on/,
  );
  // no output for the entry, then two
  expect(() => pruneUnreachable(metafile({ [join(out, "chunks/a.js")]: output([]) }), entry)).toThrow(
    /lists 0 JavaScript outputs for the entry[\s\S]*Nothing was removed/,
  );
  expect(() =>
    pruneUnreachable(
      metafile({ [join(out, "worker.js")]: output([], entry), [join(out, "chunks/a.js")]: output([], entry) }),
      entry,
    ),
  ).toThrow("lists 2 JavaScript outputs for the entry");
  expect((readdirSync(out, { recursive: true }) as string[]).sort()).toEqual([
    "chunks",
    "chunks/a.js",
    "chunks/b.js",
    "worker.js",
  ]);
});
