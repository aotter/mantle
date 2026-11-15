import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundleApp } from "../src/infrastructure/bundle.js";

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
    expect(readdirSync(join(client, "assets/client")).sort()).toEqual(["spa.js", "tiny.js"]);
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
    expect(readdirSync(join(client, "assets/client"))).toEqual(["a.js"]);
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
