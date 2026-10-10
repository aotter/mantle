/**
 * The committed reference service's plan.json is what `mantle generate` writes today (so its lowered statements are fresh against
 * this Mantle's policy and printer, not only against its version: ADR-0044), and verifyPlan finds nothing to refuse in it.
 */
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { runGenerate } from "../../src/cli/generate.js";
import { verifyPlan } from "../../src/core/index.js";
import { loweringStatus } from "../../src/core/sql/lowered.js";
import { sqliteStorage } from "../../src/d1/index.js";

const REFERENCE = fileURLToPath(new URL("../../../../docs/examples/reference-service", import.meta.url));
const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string; peerDependencies: Record<string, string> };

it("the committed reference-service plan is fresh (generate --check), lowered for this Mantle, and verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-reference-plan-"));
  await cp(REFERENCE, dir, { recursive: true, filter: (src) => !/node_modules/.test(src) });
  // "installed" packages: generate reads each one's version
  const put = async (name: string, pkg: object) => { await mkdir(join(dir, "node_modules", name), { recursive: true }); await writeFile(join(dir, "node_modules", name, "package.json"), JSON.stringify(pkg)); };
  await put("@aotter/mantle", { name: "@aotter/mantle", version: PACKAGE.version, peerDependencies: PACKAGE.peerDependencies });
  await put("@aotter/mantle-ui", { name: "@aotter/mantle-ui", version: PACKAGE.version });
  for (const [name, range] of Object.entries(PACKAGE.peerDependencies)) await put(name, { name, version: range.replace(/^[^0-9]*/, "") });

  let err = "";
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
  const o = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect([await runGenerate(["--check"], { cwd: dir }), err]).toEqual([0, ""]);
  } finally {
    e.mockRestore();
    o.mockRestore();
  }

  const { plan } = JSON.parse(readFileSync(join(REFERENCE, ".mantle/generated/plan.json"), "utf8"));
  const storage = sqliteStorage({} as never);
  expect(loweringStatus(plan, storage.dialect)).toBe("used");
  expect(await verifyPlan(plan, storage)).toEqual([]);
}, 120_000);
