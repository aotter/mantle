import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeArtifacts } from "../src/infrastructure/artifacts.js";

test("generation and --check refuse output symlinks before any writes and preserve app files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mantle-output-links-"));
  try {
    const outside = join(root, "app");
    await mkdir(outside);
    await Bun.write(join(outside, "generated.ts"), "application-owned");
    for (const kind of ["file", "parent", "root"] as const) {
      const output = join(root, kind);
      if (kind === "root") await symlink(outside, output);
      else { await mkdir(output); await symlink(kind === "file" ? join(outside, "generated.ts") : outside, join(output, kind === "file" ? "generated.ts" : "views")); }
      const name = kind === "parent" ? "views/generated.ts" : "generated.ts";
      for (const check of [false, true]) {
        await expect(writeArtifacts(output, { "first.ts": "new", [name]: "replacement" }, check)).rejects.toThrow("application-owned symlink");
        expect(await readFile(join(outside, "generated.ts"), "utf8")).toBe("application-owned");
        expect(existsSync(join(output, "first.ts"))).toBe(false);
      }
      expect((await lstat(kind === "root" ? output : join(output, kind === "file" ? "generated.ts" : "views"))).isSymbolicLink()).toBe(true);
    }
    const output = join(root, "clean"); await mkdir(output);
    await symlink(join(outside, "generated.ts"), join(output, "custom.ts"));
    await writeArtifacts(output, {});
    expect((await lstat(join(output, "custom.ts"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "generated.ts"), "utf8")).toBe("application-owned");
  } finally { await rm(root, { recursive: true, force: true }); }
});
