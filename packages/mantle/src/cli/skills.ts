import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";

/**
 * Portable location first; `.claude/skills/` stays only while Claude
 * compatibility needs it. `.agent/skills/` is no longer written — existing
 * copies are left alone rather than deleted, because a project may have
 * edited or referenced them.
 */
const PROJECT_SKILL_DIRECTORIES = [".agents", ".claude"] as const;

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
    const skills = await projectScopedSkills(sourceRoot);
    if (skills.length === 0) {
      stderr.write("mantle skills: the installed package ships no project-scoped skills.\n");
      return 2;
    }
    let stale = false;
    for (const skill of skills) {
      const expected = await readFile(join(sourceRoot, skill, "SKILL.md"), "utf8");
      for (const tool of PROJECT_SKILL_DIRECTORIES) {
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
    if (!check) stdout.write(`Mantle skills projected: ${skills.join(", ")}.\n`);
    return 0;
  } catch (error) {
    stderr.write(`mantle skills: ${message(error)}\n`);
    return 2;
  }
}

function printHelp(): void {
  stdout.write(`mantle skills — project version-matched Core skills

Usage: mantle skills [--check]

Projects every skill the installed package marks \`projection: project\` into
${PROJECT_SKILL_DIRECTORIES.map((dir) => `${dir}/skills/`).join(" and ")}.

Options:
  --check     Fail without writing when projected skills are stale
  -h, --help  This help
`);
}

/**
 * Front matter is the only scope authority: a skill lands in generated
 * projects when it declares `metadata.projection: project`. Destructive and
 * platform-specific skills stay out of that list on purpose.
 */
async function projectScopedSkills(sourceRoot: string): Promise<string[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const selected: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(sourceRoot, entry.name, "SKILL.md"), "utf8").catch(() => null);
    if (text === null) continue;
    if (projectionScopes(text).includes("project")) selected.push(entry.name);
  }
  return selected;
}

// ponytail: the front matter this reads is a fixed flat shape, so one regex
// beats pulling a YAML parser into the CLI path. `scripts/check-skills.mjs`
// fails CI if a skill stops declaring the field.
export function projectionScopes(skillMarkdown: string): string[] {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skillMarkdown);
  if (!front) return [];
  const declared = /^\s*projection:\s*(.+)$/m.exec(front[1] ?? "");
  if (!declared) return [];
  return (declared[1] ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
}

async function skillSourceRoot(): Promise<string> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  for (const candidate of [join(packageRoot, "skills"), resolve(packageRoot, "../../skills")]) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  throw new Error("Core skills are missing from the installed package");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
