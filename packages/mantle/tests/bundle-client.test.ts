import { expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundleApp, writtenAs } from "../src/infrastructure/bundle.js";
import { INPUTS_FILE, inputsFingerprint } from "../src/infrastructure/inputs.js";

/** An app with a Worker that serves no Admin and a stand-in `react` that provides the automatic JSX runtime. */
async function app() {
  const dir = await mkdtemp(join(tmpdir(), "mantle-bundle-client-"));
  await mkdir(join(dir, "src/client/widgets"), { recursive: true });
  await mkdir(join(dir, "node_modules/react"), { recursive: true });
  await writeFile(
    join(dir, "node_modules/react/package.json"),
    JSON.stringify({ name: "react", version: "1.0.0", exports: { "./jsx-runtime": "./jsx-runtime.js" } }),
  );
  await writeFile(
    join(dir, "node_modules/react/jsx-runtime.js"),
    "export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;\nexport const Fragment = 'fragment';\n",
  );
  await writeFile(join(dir, "src/worker.ts"), "export default { fetch: () => new Response('ok') };\n");
  return { dir, entry: join(dir, "src/worker.ts"), client: join(dir, "dist/client") };
}
const inDir = async (dir: string, body: () => Promise<void>) => {
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await body();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
};

test("mantle bundle builds client/<name>.ts and .tsx into <assets>/assets/client/<name>.js, with JSX, helpers and no source map", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/widgets/label.ts"), "export const label = 'helper-text';\n");
    await writeFile(
      join(dir, "src/client/spa.tsx"),
      "import { label } from './widgets/label.js';\nexport const view = <b>{label}</b>;\nwindow.__env = process.env.NODE_ENV;\n",
    );
    // the required-seam consumer module is itself a client entry (application-seams.ts, `client-entries`)
    await copyFile(resolve(import.meta.dir, "seams/client-entry.ts"), join(dir, "src/client/tiny.ts"));
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["h", "spa.js", "tiny.js"]);
    const spa = await readFile(join(client, "assets/client/spa.js"), "utf8");
    expect(spa).toContain("helper-text");
    expect(spa).toContain("production");
    expect(spa).not.toContain("sourceMappingURL");
    expect(spa).not.toContain("<b>");
    expect(await readFile(join(client, "assets/client/tiny.js"), "utf8")).toContain("client-entry-built");
    // the Worker is untouched by browser code
    expect(readdirSync(join(dir, "dist/worker")).join()).not.toContain("spa");
    expect(existsSync(join(dir, "dist/client/admin"))).toBe(false);
    // the record lives outside the uploaded assets
    expect(existsSync(join(client, ".mantle-client"))).toBe(false);
  });
});

test("mantle bundle removes a deleted entry's output, and everything when the last entry is deleted", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/a.ts"), "console.log('a');\n");
    await writeFile(join(dir, "src/client/b.ts"), "console.log('b');\n");
    await mkdir(client, { recursive: true });
    await writeFile(join(client, "frontend.js"), "another build step's file");
    await bundleApp(entry, join(dir, "dist"));
    await rm(join(dir, "src/client/b.ts"));
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["a.js", "h"]);
    expect(readdirSync(join(client, "assets/client/h"))).toEqual([expect.stringMatching(/^a-[0-9a-f]{16}\.js$/)]);
    await rm(join(dir, "src/client/a.ts"));
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(client, "assets/client"))).toBe(false);
    expect(await readFile(join(client, "frontend.js"), "utf8")).toBe("another build step's file");
  });
});

test("mantle bundle without client entries leaves the assets directory as it was", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await mkdir(join(dir, "public/assets"), { recursive: true });
    await writeFile(join(dir, "public/assets/logo.svg"), "<svg/>");
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(client, { recursive: true }).sort()).toEqual(["assets", "assets/logo.svg"]);
    expect(existsSync(join(dir, "dist/.mantle-client"))).toBe(false);
    // a client directory with no entry (helpers only, or a declaration file) builds nothing
    await writeFile(join(dir, "src/client/widgets/label.ts"), "export const label = 1;\n");
    await writeFile(join(dir, "src/client/globals.d.ts"), "export {};\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(client, { recursive: true }).sort()).toEqual(["assets", "assets/logo.svg"]);
  });
});

test("mantle bundle refuses public/assets/client and two entries that share a name", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/spa.ts"), "console.log(1);\n");
    await mkdir(join(dir, "public/assets/client"), { recursive: true });
    await writeFile(join(dir, "public/assets/client/spa.js"), "the app's own file");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("public/assets/client is reserved");
    await expect(bundleApp(entry, join(dir, "dist"), join(dir, "public"))).rejects.toThrow("is reserved");
    expect(existsSync(client)).toBe(false);
    expect(await readFile(join(dir, "public/assets/client/spa.js"), "utf8")).toBe("the app's own file");
    await rm(join(dir, "public/assets/client"), { recursive: true });
    await writeFile(join(dir, "src/client/spa.tsx"), "console.log(2);\n");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("spa.ts and spa.tsx");
  });
});

test("mantle bundle keeps building after a failed entry, and an output directory it did not write is refused", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/spa.ts"), "import { x } from 'node:fs';\nconsole.log(x);\n");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow();
    await writeFile(join(dir, "src/client/spa.ts"), "console.log(1);\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(client, "assets/client/spa.js"))).toBe(true);
    await rm(join(dir, "dist/.mantle-client"));
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("not written by mantle bundle");
  });
});

test("mantle bundle deletes only the directory it recorded for this assets directory, and ignores an unreadable record", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    const dist = join(dir, "dist"),
      record = join(dist, ".mantle-client");
    await writeFile(join(dir, "src/client/spa.ts"), "console.log(1);\n");
    await bundleApp(entry, dist);
    // a record naming a directory elsewhere, or one whose path only ends alike, deletes nothing
    for (const elsewhere of [join(dir, "victim/assets/client"), join(dir, "x/myassets/client"), join(dir, "other")]) {
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, "keep.txt"), "keep");
      await writeFile(record, JSON.stringify({ dir: elsewhere }));
      await rm(join(client, "assets/client"), { recursive: true });
      await bundleApp(entry, dist);
      expect(await readFile(join(elsewhere, "keep.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(client, "assets/client/spa.js"))).toBe(true);
    }
    // a truncated or malformed record is treated as absent
    for (const text of ['{"dir": "/tm', "", "[]", '{"dir": 1}']) {
      await writeFile(record, text);
      await rm(join(client, "assets/client"), { recursive: true });
      await bundleApp(entry, dist);
      expect(existsSync(join(client, "assets/client/spa.js"))).toBe(true);
    }
    // the recorded directory of this build is removed
    await rm(join(dir, "src/client/spa.ts"));
    await bundleApp(entry, dist);
    expect(existsSync(join(client, "assets/client"))).toBe(false);
  });
});

test("mantle bundle skips dotfiles, declaration, test and spec files, and compares entry names without case", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    for (const name of ["spa.tsx", ".hidden.ts", "spa.test.tsx", "spa.spec.ts", "types.d.ts", "notes.md", "retest.ts"])
      await writeFile(join(dir, "src/client", name), "console.log(1);\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["h", "retest.js", "spa.js"]);
    await writeFile(join(dir, "src/client/Spa.ts"), "console.log(2);\n");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("compared without case");
  });
});

test("mantle bundle writes the CSS an entry imports beside its JavaScript, and refuses an unloadable import", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/spa.css"), "body{color:red}\n");
    await writeFile(join(dir, "src/client/spa.ts"), "import './spa.css';\nconsole.log(1);\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["h", "spa.css", "spa.js"]);
    expect(await readFile(join(client, "assets/client/spa.css"), "utf8")).toContain("color");
    await writeFile(join(dir, "src/client/logo.png"), "x");
    await writeFile(join(dir, "src/client/spa.ts"), "import logo from './logo.png';\nconsole.log(logo);\n");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow();
  });
});

const hashedRule = "/assets/client/h/*\n  ! Cache-Control\n  Cache-Control: public, max-age=86400, immutable\n";
/** A Worker answering with the required-seam consumer module's paths (`client-assets` in application-seams.ts). */
async function seamWorker(dir: string) {
  await copyFile(resolve(import.meta.dir, "seams/client-assets.ts"), join(dir, "src/seam.ts"));
  await writeFile(
    join(dir, "src/worker.ts"),
    "import { script, stylesheet } from './seam.js';\nexport default { fetch: () => new Response(`${script} ${stylesheet}`) };\n",
  );
}
/** The built Worker's answer, from a copy under a new name (a module is evaluated once per path). */
let builds = 0;
async function served(dir: string): Promise<string> {
  const copy = join(dir, `dist/run-${++builds}.js`);
  await copyFile(join(dir, "dist/worker/worker.js"), copy);
  const { default: worker } = await import(copy);
  return (await worker.fetch()).text();
}

test("mantle bundle writes a content-hashed copy of each entry and its CSS, and gives the Worker their names", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await seamWorker(dir);
    await writeFile(join(dir, "src/client/page.css"), "body{color:red}\n");
    await writeFile(join(dir, "src/client/page.ts"), "import './page.css';\nconsole.log('page');\n");
    await writeFile(join(dir, "src/client/save.tsx"), "export const view = <b>save</b>;\n");
    await bundleApp(entry, join(dir, "dist"));
    const out = join(client, "assets/client");
    // the stable names are unchanged; the copies sit in h/ with the same bytes
    expect(readdirSync(out).sort()).toEqual(["h", "page.css", "page.js", "save.js"]);
    const hashed = readdirSync(join(out, "h")).sort();
    expect(hashed).toHaveLength(3);
    for (const name of hashed) {
      expect(name).toMatch(/^(page|save)-[0-9a-f]{16}\.(js|css)$/);
      expect(await readFile(join(out, "h", name), "utf8")).toBe(
        await readFile(join(out, name.replace(/-[0-9a-f]{16}/, "")), "utf8"),
      );
    }
    const [pageCss, pageJs] = hashed.filter(name => name.startsWith("page-"));
    expect(await served(dir)).toBe(`/assets/client/h/${pageJs} /assets/client/h/${pageCss}`);
    expect(await readFile(join(client, "_headers"), "utf8")).toBe(hashedRule);
    // the same content keeps its name; changed content gets a new one, and the previous copy is not kept
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(out, "h")).sort()).toEqual(hashed);
    await writeFile(join(dir, "src/client/page.css"), "body{color:blue}\n");
    await bundleApp(entry, join(dir, "dist"));
    const changed = readdirSync(join(out, "h")).sort();
    const css = changed.find(name => name.endsWith(".css")) ?? "";
    expect(changed).toEqual([css, ...hashed.filter(name => name.endsWith(".js"))].sort());
    expect(css).not.toBe(pageCss);
    expect(await served(dir)).toBe(`/assets/client/h/${pageJs} /assets/client/h/${css}`);
    // a Worker that does not import the map bundles nothing of it
    await writeFile(join(dir, "src/worker.ts"), "export default { fetch: () => new Response('ok') };\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(await readFile(join(dir, "dist/worker/worker.js"), "utf8")).not.toContain("/assets/client/h/");
  });
});

test("without client entries the map is empty, the Worker falls back to the stable names, and no _headers is written", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await seamWorker(dir);
    await bundleApp(entry, join(dir, "dist"));
    expect(await served(dir)).toBe("/assets/client/page.js /assets/client/page.css");
    expect(existsSync(client)).toBe(false);
    // the package's own module is the same empty map wherever mantle bundle does not replace it (a Bun server, a test)
    const { clientAssets } = await import("../src/kernel/client-assets.js");
    expect(clientAssets).toEqual({});
  });
});

test("the hashed rule is appended to a _headers copied from public/, and an application's own file is only told it", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/spa.ts"), "console.log(1);\n");
    await mkdir(join(dir, "public"), { recursive: true });
    const own = "/assets/*\n  Cache-Control: public, max-age=600\n";
    await writeFile(join(dir, "public/_headers"), own);
    await bundleApp(entry, join(dir, "dist"));
    expect(await readFile(join(client, "_headers"), "utf8")).toBe(`${own}\n${hashedRule}`);
    expect(await readFile(join(dir, "public/_headers"), "utf8")).toBe(own);
    // a rule of its own for the path is the application's choice
    const chosen = `${own}\n/assets/client/h/*\n  Cache-Control: public, max-age=86400\n`;
    await writeFile(join(dir, "public/_headers"), chosen);
    await bundleApp(entry, join(dir, "dist"));
    expect(await readFile(join(client, "_headers"), "utf8")).toBe(chosen);
    // public/ as the assets directory: its _headers is the application's, never edited
    await writeFile(join(dir, "public/_headers"), own);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bundleApp(entry, join(dir, "dist"), join(dir, "public"));
      expect(warn.mock.calls.flat().join("\n")).toContain(`has no /assets/client/h/* rule; add:\n${hashedRule}`);
    } finally {
      warn.mockRestore();
    }
    expect(await readFile(join(dir, "public/_headers"), "utf8")).toBe(own);
  });
});

test("a rebuild never removes a file both builds have, and removes the previous build's copies only after writing", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/page.ts"), "console.log('page');\n");
    await writeFile(join(dir, "src/client/save.ts"), "console.log('save');\n");
    await bundleApp(entry, join(dir, "dist"));
    const h = join(client, "assets/client/h");
    const [page, save] = readdirSync(h).sort();
    const before = statSync(join(h, page!));
    await writeFile(join(dir, "src/client/save.ts"), "console.log('saved');\n");
    await bundleApp(entry, join(dir, "dist"));
    // the unchanged copy is the same file, never deleted or rewritten; the changed one has a new name, the old one is gone
    const after = statSync(join(h, page!));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    const now = readdirSync(h).sort();
    expect(now).toHaveLength(2);
    expect(now).toContain(page!);
    expect(now).not.toContain(save!);
    // a copy whose bytes do not match its name (a build that stopped while writing it) is written again
    await writeFile(join(h, page!), "truncated");
    await bundleApp(entry, join(dir, "dist"));
    expect(await readFile(join(h, page!), "utf8")).toBe(await readFile(join(client, "assets/client/page.js"), "utf8"));
  });
});

test("the build's own _headers is removed when a later build has no rules; a copied or an application's file is not", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/spa.ts"), "console.log(1);\n");
    await bundleApp(entry, join(dir, "dist"));
    expect(await readFile(join(client, "_headers"), "utf8")).toBe(hashedRule);
    await rm(join(dir, "src/client/spa.ts"));
    await bundleApp(entry, join(dir, "dist"));
    expect(existsSync(join(client, "_headers"))).toBe(false);
    // a file with a rule of the application's own stays
    const own = "/assets/*\n  Cache-Control: public, max-age=600\n";
    await mkdir(client, { recursive: true });
    await writeFile(join(client, "_headers"), `${own}\n${hashedRule}`);
    await bundleApp(entry, join(dir, "dist"));
    expect(await readFile(join(client, "_headers"), "utf8")).toBe(`${own}\n${hashedRule}`);
    // public/ as the assets directory: its _headers is a source file, never removed
    await mkdir(join(dir, "public"), { recursive: true });
    await writeFile(join(dir, "public/_headers"), hashedRule);
    await bundleApp(entry, join(dir, "dist"), join(dir, "public"));
    expect(await readFile(join(dir, "public/_headers"), "utf8")).toBe(hashedRule);
  });
});

test("a bun-* build writes the browser entries under their stable names only: no hashed copies, no rule", async () => {
  const { dir, client } = await app();
  await inDir(dir, async () => {
    const entry = join(dir, "src/server.ts"),
      generated = join(dir, "generated"),
      manifest = join(dir, "app.yaml");
    await mkdir(generated);
    await writeFile(manifest, "kind: Schema\n");
    await writeFile(join(generated, "generated.ts"), "export const store = 1;\n");
    await writeFile(join(generated, INPUTS_FILE), inputsFingerprint(generated, [manifest], "bun-sqlite"));
    await writeFile(entry, 'import { store } from "../generated/generated.js";\nconsole.log(store);\n');
    await writeFile(join(dir, "src/client/page.ts"), "console.log('page');\n");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bundleApp(entry, join(dir, "dist"));
      expect(readdirSync(join(client, "assets/client"))).toEqual(["page.js"]);
      // a directory an earlier Worker build left behind loses its copies too
      await mkdir(join(client, "assets/client/h"));
      await writeFile(join(client, "assets/client/h/page-0000000000000000.js"), "old");
      await bundleApp(entry, join(dir, "dist"));
      expect(readdirSync(join(client, "assets/client"))).toEqual(["page.js"]);
      expect(existsSync(join(client, "_headers"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

test("the map's keys are in code-unit order, and an entry named like an Object.prototype member is refused", async () => {
  const { dir, entry } = await app();
  await inDir(dir, async () => {
    await writeFile(
      join(dir, "src/worker.ts"),
      "import { clientAssets } from '@aotter/mantle/client-assets';\nexport default { fetch: () => new Response(Object.keys(clientAssets).join()) };\n",
    );
    for (const name of ["b", "C", "a", "Z", "é"])
      await writeFile(join(dir, `src/client/${name}-x.ts`), `console.log('${name}');\n`);
    await bundleApp(entry, join(dir, "dist"));
    // localeCompare would give a-x,b-x,C-x,é-x,Z-x
    expect(await served(dir)).toBe("C-x,Z-x,a-x,b-x,é-x");
    for (const name of ["constructor", "__proto__", "toString"]) {
      await writeFile(join(dir, `src/client/${name}.ts`), "console.log(1);\n");
      await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow(`every JavaScript object has "${name}"`);
      await rm(join(dir, `src/client/${name}.ts`));
    }
  });
});

test("a browser file that keeps @aotter/mantle/client-assets after tree shaking is noted; one that drops it is not", async () => {
  const { dir, entry } = await app();
  await inDir(dir, async () => {
    // the package's module as installed: the browser build resolves it like any import
    await mkdir(join(dir, "node_modules/@aotter/mantle/dist/kernel"), { recursive: true });
    await writeFile(
      join(dir, "node_modules/@aotter/mantle/package.json"),
      JSON.stringify({ name: "@aotter/mantle", exports: { "./client-assets": "./dist/kernel/client-assets.js" } }),
    );
    await copyFile(
      resolve(import.meta.dir, "../dist/kernel/client-assets.js"),
      join(dir, "node_modules/@aotter/mantle/dist/kernel/client-assets.js"),
    );
    await writeFile(
      join(dir, "src/pages.ts"),
      "import { clientAssets } from '@aotter/mantle/client-assets';\nexport const href = () => clientAssets.page?.js;\nexport const label = 'label';\n",
    );
    await writeFile(join(dir, "src/client/page.ts"), "import { label } from '../pages.js';\nconsole.log(label);\n");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bundleApp(entry, join(dir, "dist"));
      expect(warn.mock.calls.flat().join("\n")).not.toContain("client-assets");
      await writeFile(join(dir, "src/client/page.ts"), "import { href } from '../pages.js';\nconsole.log(href());\n");
      await bundleApp(entry, join(dir, "dist"));
      expect(warn.mock.calls.flat().join("\n")).toContain(
        "uses @aotter/mantle/client-assets, which is empty in a browser file",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

test("a build that fails before writing the browser entries leaves the directory owned: the next build succeeds", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/page.ts"), "console.log('page');\n");
    await bundleApp(entry, join(dir, "dist"));
    await mkdir(join(dir, "public/assets/client"), { recursive: true });
    await writeFile(join(dir, "public/assets/client/x.txt"), "x");
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("public/assets/client is reserved");
    await rm(join(dir, "public"), { recursive: true });
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["h", "page.js"]);
  });
});

test("the previous build's hashed copies are removed only after the Worker naming the new ones is built", async () => {
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    const h = join(client, "assets/client/h"),
      worker = await readFile(entry, "utf8");
    await writeFile(join(dir, "src/client/page.ts"), "console.log('page');\n");
    await bundleApp(entry, join(dir, "dist"));
    const [previous] = readdirSync(h);
    await writeFile(join(dir, "src/client/page.ts"), "console.log('changed');\n");
    // fails only in the Worker build: the first pass, with packages external, reads the entry fine
    await writeFile(entry, `import "not-installed";\n${worker}`);
    await expect(bundleApp(entry, join(dir, "dist"))).rejects.toThrow("not-installed");
    // the new copy is written; the one the previous Worker names is still there
    const during = readdirSync(h);
    expect(during).toHaveLength(2);
    expect(during).toContain(previous!);
    await writeFile(entry, worker);
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(h)).toEqual(during.filter(name => name !== previous));
  });
});

test("an entry renamed by case only: the sweep keeps (and respells) the file just written on a case-insensitive disk", async () => {
  // a simulated case-insensitive listing: the file just written is listed under its old spelling
  const written = new Set(["/a/page.js", "/a/h/page-0123456789abcdef.js"]);
  const one = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  expect(writtenAs("/a/Page.js", written, one)).toBe("/a/page.js");
  expect(writtenAs("/a/h/Page-0123456789abcdef.js", written, one)).toBe("/a/h/page-0123456789abcdef.js");
  expect(writtenAs("/a/page.js", written, one)).toBe("/a/page.js");
  expect(writtenAs("/a/other.js", written, one)).toBeUndefined();
  // on a case-sensitive disk the old spelling is another file, and stale
  expect(writtenAs("/a/Page.js", written, () => false)).toBeUndefined();
  // the build on this (case-sensitive) disk removes the old spelling's files
  const { dir, entry, client } = await app();
  await inDir(dir, async () => {
    await writeFile(join(dir, "src/client/Page.ts"), "console.log('page');\n");
    await bundleApp(entry, join(dir, "dist"));
    renameSync(join(dir, "src/client/Page.ts"), join(dir, "src/client/page.ts"));
    await bundleApp(entry, join(dir, "dist"));
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["h", "page.js"]);
    expect(readdirSync(join(client, "assets/client/h"))).toEqual([expect.stringMatching(/^page-[0-9a-f]{16}\.js$/)]);
  });
});
