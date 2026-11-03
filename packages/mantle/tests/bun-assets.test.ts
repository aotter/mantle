import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunAdminAssets } from "../src/bun/assets.js";

test("Bun Admin reader serves files and refuses malformed paths and escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-assets-"));
  const outside = root + "-outside.html";
  try {
    await writeFile(join(root, "index.html"), "<h1>Admin</h1>");
    await writeFile(outside, "private");
    await symlink(outside, join(root, "escape.html"));
    await mkdir(join(root, "folder"));
    const assets = bunAdminAssets(root);
    const shell = (await assets("/index.html"))!;
    expect(await shell.text()).toBe("<h1>Admin</h1>");
    expect([shell.headers.get("x-content-type-options"), shell.headers.get("cache-control")]).toEqual(["nosniff", null]);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets/index-abc123.js"), "export {}");
    const chunk = (await assets("/assets/index-abc123.js"))!;
    expect([chunk.headers.get("x-content-type-options"), chunk.headers.get("cache-control")]).toEqual(["nosniff", "public, max-age=31536000, immutable"]);
    expect(chunk.headers.get("content-type")).toContain("javascript");
    for (const path of ["/folder", "/escape.html", "/missing.html", "/%", "/%00", "/%5c", "/%2e%2e%2fprivate.html"]) expect(await assets(path)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside); }
});
