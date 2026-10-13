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
    expect(await (await assets("/index.html"))!.text()).toBe("<h1>Admin</h1>");
    for (const path of ["/folder", "/escape.html", "/missing.html", "/%", "/%00", "/%5c", "/%2e%2e%2fprivate.html"]) expect(await assets(path)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside); }
});
