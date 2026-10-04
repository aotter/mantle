#!/usr/bin/env node
// Enforces the disclosure audit in skills/README.md: front matter is the only
// distribution authority, the audit table states the same distribution and
// reason, and every relative link resolves inside what is actually shipped.
//
// Two distributions (ADR-0032 decision 13): the plugin's one `mantle` skill
// under skills/ (copied with its scripts), and the package skills under
// docs/skills/ (shipped in @aotter/mantle's docs/, read from node_modules).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

// ponytail: front matter here is a fixed flat shape, so one regex beats a YAML
// dependency in a repo-root script.
function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  return (key) => {
    const found = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(match[1]);
    return found ? found[1].trim() : null;
  };
}

const directories = (path) => existsSync(path)
  ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];

// skill -> { file, projection it must declare, the directory its links must stay inside }
const skills = new Map();
for (const name of directories(join(repoRoot, "skills"))) {
  skills.set(name, { where: `skills/${name}/SKILL.md`, projection: "plugin", root: join(repoRoot, "skills", name) });
}
for (const name of directories(join(repoRoot, "docs", "skills"))) {
  const where = `docs/skills/${name}/SKILL.md`;
  if (skills.has(name)) fail(where, `skill name ${name} is already shipped by ${skills.get(name).where}`);
  else skills.set(name, { where, projection: "package", root: join(repoRoot, "docs") });
}
if ([...skills.values()].filter((s) => s.projection === "plugin").length !== 1 || skills.get("mantle")?.projection !== "plugin") {
  fail("skills/", "the plugin ships exactly one skill, skills/mantle");
}

const declared = new Map();
for (const [name, { where, projection, root }] of skills) {
  const file = join(repoRoot, where);
  if (!existsSync(file)) {
    fail(where, "missing SKILL.md");
    continue;
  }
  const text = readFileSync(file, "utf8");
  const front = frontMatter(text);
  if (!front) {
    fail(where, "missing front matter");
    continue;
  }
  if (front("name") !== name) fail(where, `front-matter name must equal the folder name (${name})`);
  if (!front("description")) fail(where, "missing description");
  if (front("sourcePath") !== where) fail(where, `metadata.sourcePath must be ${where}`);
  if (front("projection") !== projection) fail(where, `metadata.projection must be \`${projection}\``);
  declared.set(name, { projection: front("projection"), reason: front("projectionReason") });

  for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(dirname(file), target.split("#")[0]);
    if (!existsSync(path)) fail(where, `dead link: ${target}`);
    // a link that leaves what ships resolves here and is missing wherever the skill is read
    else if (relative(root, path).startsWith(`..${sep}`) || relative(root, path) === "..") fail(where, `link leaves the shipped files: ${target}`);
  }
}

// The README audit table is the human view of the same front matter.
const readme = readFileSync(join(repoRoot, "skills", "README.md"), "utf8");
const rows = [...readme.matchAll(/^\| `([a-z-]+)` \|(.+)$/gm)].map((match) => ({
  skill: match[1],
  cells: match[2].split("|").map((cell) => cell.trim()),
}));
const names = [...skills.keys()].sort();
const audited = rows.map((row) => row.skill).sort();
if (audited.join() !== names.join()) {
  fail("skills/README.md", `disclosure audit rows ${JSON.stringify(audited)} do not match shipped skills ${JSON.stringify(names)}`);
}
for (const { skill, cells } of rows) {
  const front = declared.get(skill);
  if (!front) continue;
  // …| Distribution | Restricted because | (trailing empty cell from the final pipe)
  if (cells.at(-3) !== front.projection) fail("skills/README.md", `${skill}: audit table says "${cells.at(-3)}", front matter says "${front.projection}"`);
  if (cells.at(-2) !== (front.reason ?? "—")) fail("skills/README.md", `${skill}: audit table reason does not match projectionReason`);
}

if (failures.length > 0) {
  console.error(`check-skills: ${failures.length} problem(s)\n${failures.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-skills: ${skills.size} skills (${names.join(", ")})`);
