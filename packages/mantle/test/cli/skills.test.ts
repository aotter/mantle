import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectionScopes, runSkills } from "../../src/cli/skills.js";

const originalCwd = process.cwd();
const skillsRoot = join(originalCwd, "../../skills");

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

describe("projectionScopes", () => {
  it("reads the declared scopes", () => {
    expect(projectionScopes("---\nname: x\nmetadata:\n  projection: project, plugin\n---\n"))
      .toEqual(["project", "plugin"]);
    expect(projectionScopes("---\nname: x\nmetadata:\n  projection: plugin\n---\n")).toEqual(["plugin"]);
  });

  it("returns nothing when the field or front matter is absent", () => {
    expect(projectionScopes("---\nname: x\n---\n")).toEqual([]);
    expect(projectionScopes("# no front matter\n")).toEqual([]);
  });
});

describe("mantle skills", () => {
  it("projects declared skills, fails closed on drift, and ignores legacy copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mantle-skills-"));
    const legacy = join(root, ".agent", "skills", "mantle-develop", "SKILL.md");
    try {
      process.chdir(root);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await mkdir(join(root, ".agent", "skills", "mantle-develop"), { recursive: true });
      await writeFile(legacy, "user edited this", "utf8");

      expect(await runSkills([])).toBe(0);

      const source = await readFile(join(skillsRoot, "develop", "SKILL.md"), "utf8");
      for (const tool of [".agents", ".claude"]) {
        expect(await readFile(join(root, tool, "skills", "mantle-develop", "SKILL.md"), "utf8")).toBe(source);
        await expect(stat(join(root, tool, "skills", "mantle-media-gc"))).rejects.toThrow();
      }
      expect(await readFile(legacy, "utf8")).toBe("user edited this");
      await expect(stat(join(root, ".agent", "skills", "mantle-plugin"))).rejects.toThrow();
      expect(await runSkills(["--check"])).toBe(0);

      const stale = join(root, ".agents", "skills", "mantle-develop", "SKILL.md");
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
