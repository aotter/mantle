import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";

const PROJECT_SKILLS = ["develop", "plugin", "theme", "update"] as const;

export async function runSkills(rawArgs: readonly string[]): Promise<number> {
  let check: boolean;
  try {
    const { values } = parseArgs({
      args: [...rawArgs],
      options: {
        check: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      printHelp();
      return 0;
    }
    check = values.check === true;
  } catch (error) {
    stderr.write(`${message(error)}\n`);
    return 2;
  }

  try {
    const sourceRoot = await skillSourceRoot();
    let stale = false;
    for (const skill of PROJECT_SKILLS) {
      const expected = await readFile(join(sourceRoot, skill, "SKILL.md"), "utf8");
      for (const tool of [".agent", ".claude"]) {
        const target = resolve(cwd(), tool, "skills", `mantle-${skill}`, "SKILL.md");
        const current = await readFile(target, "utf8").catch(() => null);
        if (current === expected) continue;
        stale = true;
        if (check) {
          stderr.write(`Mantle skill is stale: ${relative(cwd(), target)}\n`);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, expected, "utf8");
      }
    }
    if (stale && check) {
      stderr.write("Mantle skills are stale; run `mantle skills`.\n");
      return 1;
    }
    if (!check) stdout.write("Mantle skills projected.\n");
    return 0;
  } catch (error) {
    stderr.write(`mantle skills: ${message(error)}\n`);
    return 2;
  }
}

function printHelp(): void {
  stdout.write(`mantle skills — project version-matched Core skills

Usage: mantle skills [--check]

Options:
  --check     Fail without writing when projected skills are stale
  -h, --help  This help
`);
}

async function skillSourceRoot(): Promise<string> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const candidate of [join(packageRoot, "skills"), resolve(packageRoot, "../../skills")]) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  throw new Error("Core skills are missing from the installed package");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
