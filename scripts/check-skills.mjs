#!/usr/bin/env node
// Enforces the disclosure audit in skills/README.md: front matter is the only
// projection-scope authority, the audit table states the same scope the code
// acts on, restricted scopes carry a reason, links resolve from wherever the
// skill is read.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const SCOPES = new Set(["project", "plugin"]);
const failures = [];

const fail = (where, message) => failures.push(`${where}: ${message}`);

// ponytail: front matter here is a fixed flat shape, so one regex beats a YAML
// dependency in a repo-root script. `projectionScopes` in
// packages/mantle/src/cli/skills.ts reads the same field the same way — keep the
// two expressions identical if either changes.
function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  return (key) => {
    const found = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(match[1]);
    return found ? found[1].trim() : null;
  };
}

const scopesOf = (declared) => (declared ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);

const skills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skills.length === 0) fail("skills/", "no skills found");

const declaredScope = new Map();
const declaredReason = new Map();
const projected = [];

for (const skill of skills) {
  const file = join(skillsRoot, skill, "SKILL.md");
  const where = `skills/${skill}/SKILL.md`;
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

  if (front("name") !== skill) fail(where, `front-matter name must equal the folder name (${skill})`);
  if (!front("description")) fail(where, "missing description");

  const raw = front("projection");
  const scopes = scopesOf(raw);
  declaredScope.set(skill, scopes.join(", "));
  declaredReason.set(skill, front("projectionReason"));
  if (!raw) {
    fail(where, "missing metadata.projection (declare `project`, `plugin`, or both)");
  } else {
    const unknown = scopes.filter((scope) => !SCOPES.has(scope));
    if (unknown.length > 0) fail(where, `unknown projection scope: ${unknown.join(", ")}`);
    if (scopes.includes("project")) projected.push(skill);
    // A skill kept out of generated projects is a safety decision; make it explain itself.
    else if (!front("projectionReason")) fail(where, "projection excludes `project` but no projectionReason is given");
  }

  for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    // `mantle skills` copies SKILL.md alone, so a project-scoped skill cannot
    // reference a sibling file: it would resolve in this repository and be
    // missing everywhere the skill is actually read.
    if (scopes.includes("project")) {
      fail(where, `relative link is unreachable once projected: ${target}`);
      continue;
    }
    if (!existsSync(resolve(dirname(file), target.split("#")[0]))) fail(where, `dead link: ${target}`);
  }
}

// The README audit table is the human view of the same front matter, and the
// column a reviewer reads when deciding whether a destructive skill belongs in
// generated projects. Assert it says what the code will do.
const readme = readFileSync(join(skillsRoot, "README.md"), "utf8");
const rows = [...readme.matchAll(/^\| `([a-z-]+)` \|(.+)$/gm)].map((match) => ({
  skill: match[1],
  cells: match[2].split("|").map((cell) => cell.trim()),
}));
const audited = rows.map((row) => row.skill).sort();
if (audited.join() !== skills.join()) {
  fail("skills/README.md", `disclosure audit rows ${JSON.stringify(audited)} do not match shipped skills ${JSON.stringify(skills)}`);
}
for (const { skill, cells } of rows) {
  if (!declaredScope.has(skill)) continue;
  // …| Projection | Restricted because | (trailing empty cell from the final pipe)
  const projection = cells.at(-3);
  const restricted = cells.at(-2);
  if (projection !== declaredScope.get(skill)) {
    fail("skills/README.md", `${skill}: audit table says projection "${projection}", front matter says "${declaredScope.get(skill)}"`);
  }
  const reason = declaredReason.get(skill);
  if (reason && restricted !== reason) {
    fail("skills/README.md", `${skill}: audit table reason does not match projectionReason`);
  }
  if (!reason && restricted !== "—") {
    fail("skills/README.md", `${skill}: audit table gives a restriction reason but front matter declares none`);
  }
}

if (failures.length > 0) {
  console.error(`check-skills: ${failures.length} problem(s)\n${failures.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-skills: ${skills.length} skills, ${projected.length} projected into generated projects (${projected.join(", ")})`);
