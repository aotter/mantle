import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSkills } from "../src/skills.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("mantle skills", () => {
  it("projects one source to both tool paths and fails closed on one-byte drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-skills-"));
    try {
      process.chdir(root);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(await runSkills([])).toBe(0);

      for (const skill of ["develop", "plugin", "theme", "update"]) {
        const source = await readFile(join(originalCwd, "../../skills", skill, "SKILL.md"), "utf8");
        const agent = await readFile(join(root, ".agent", "skills", `mantle-${skill}`, "SKILL.md"), "utf8");
        const claude = await readFile(join(root, ".claude", "skills", `mantle-${skill}`, "SKILL.md"), "utf8");
        expect(agent).toBe(source);
        expect(claude).toBe(source);
      }
      expect(await runSkills(["--check"])).toBe(0);

      const stale = join(root, ".agent", "skills", "mantle-develop", "SKILL.md");
      await writeFile(stale, `${await readFile(stale, "utf8")}x`, "utf8");
      const before = await readFile(stale, "utf8");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(await runSkills(["--check"])).toBe(1);
      expect(stderr).toHaveBeenCalledWith("Mantle skills are stale; run `mantle skills`.\n");
      expect(await readFile(stale, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
