import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "..");
// a directory inside the package, so the built Admin resolves `@aotter/mantle` as an application's install does
const temp = mkdtempSync(join(pkg, ".bundle-upload-card-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const { bundle } = (await import(resolve(pkg, "node_modules/@aotter/mantle/dist/infrastructure/bundle.js"))) as {
  bundle(entry: string, outdir: string): Promise<unknown>;
};
const mcp = JSON.stringify(resolve(pkg, "dist/server/mcp.js"));

/** `mantle bundle`'s Worker for `source`: its uploaded chunks and the loaded entry. */
async function worker(name: string, source: string) {
  const entry = join(temp, `${name}.js`),
    out = join(temp, name);
  writeFileSync(entry, source);
  await bundle(entry, out);
  return {
    chunks: readdirSync(join(out, "chunks")).map(file => file.replace(/-[A-Z0-9]+\.js$/, "")),
    module: await import(pathToFileURL(join(out, `${name}.js`)).href),
  };
}

it("the upload card a Worker serves is uploaded and loads; a Worker without mediaUploadCard uploads none", async () => {
  const used = await worker(
    "used",
    `import { mediaUploadCard } from ${mcp};\nexport const apps = mediaUploadCard({ media: () => ({ uploadOrigin: "https://bucket.example.test" }) });`,
  );
  expect(used.chunks).toContain("upload-card");
  const { html } = await used.module.apps.resources[0].html({ env: {} });
  expect(html).toContain("<html");
  // the same module, mediaUploadCard tree-shaken (the reference service's shape)
  const unused = await worker("unused", `export { adminMcpApps } from ${mcp};`);
  expect(unused.chunks).not.toContain("upload-card");
  expect(typeof unused.module.adminMcpApps).toBe("function");
});
