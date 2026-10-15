import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Admin is built by the application (`mantle bundle`), not shipped prebuilt: build the built-in entry as an app does. */
export async function buildDefaultAdmin(): Promise<{ dist: string; remove: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "mantle-admin-browser-"));
  const dist = join(root, "client/admin");
  const { buildAdmin } = await import(resolve(import.meta.dirname, "../../dist/build/index.js")) as typeof import("../../src/build/index.js");
  await buildAdmin({ outDir: dist });
  return { dist, remove: () => rmSync(root, { recursive: true, force: true }) };
}
