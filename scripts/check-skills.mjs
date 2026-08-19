#!/usr/bin/env node
// Enforces the disclosure audit in skills/README.md: front-matter is the only
// projection-scope authority, restricted scopes carry a reason, links resolve,
// and every skill actually reaches the packed artifact.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const SCOPES = new Set(["project", "plugin"]);
const failures = [];

const fail = (where, message) => failures.push(`${where}: ${message}`);

// ponytail: front-matter here is a fixed flat shape, so one regex beats a YAML
// dependency in a repo-root script. Move to the `yaml` package if the shape
// ever nests.
function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const read = (key) => {
    const found = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(match[1]);
    return found ? found[1].trim().replace(/^["']|["']$/g, "") : null;
  };
  return { raw: match[1], read };
}

const skills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skills.length === 0) fail("skills/", "no skills found");

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

  if (front.read("name") !== skill) fail(where, `front-matter name must equal the folder name (${skill})`);
  if (!front.read("description")) fail(where, "missing description");

  const raw = front.read("projection");
  if (!raw) {
    fail(where, "missing metadata.projection (declare `project`, `plugin`, or both)");
  } else {
    const scopes = raw.split(",").map((value) => value.trim()).filter(Boolean);
    const unknown = scopes.filter((scope) => !SCOPES.has(scope));
    if (unknown.length > 0) fail(where, `unknown projection scope: ${unknown.join(", ")}`);
    if (scopes.includes("project")) projected.push(skill);
    // A skill kept out of generated projects is a safety decision; make it explain itself.
    else if (!front.read("projectionReason")) fail(where, "projection excludes `project` but no projectionReason is given");
  }

  // Dead links: every relative target must exist in the shipped tree.
  for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const resolved = resolve(dirname(file), target.split("#")[0]);
    if (!existsSync(resolved)) fail(where, `dead link: ${target}`);
  }
}

// The README audit table is the human view of the same front matter.
const readme = readFileSync(join(skillsRoot, "README.md"), "utf8");
const audited = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]).sort();
if (audited.join() !== skills.join()) {
  fail("skills/README.md", `disclosure audit rows ${JSON.stringify(audited)} do not match shipped skills ${JSON.stringify(skills)}`);
}

// Reachability from the installed package: prepack copies skills/ in, files ships it.
const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/mantle/package.json"), "utf8"));
if (!(pkg.files ?? []).includes("skills")) fail("packages/mantle/package.json", '"files" must include "skills"');
const sync = readFileSync(join(repoRoot, "scripts/sync-package-docs.mjs"), "utf8");
if (!sync.includes('"skills"')) fail("scripts/sync-package-docs.mjs", "no longer copies skills/ into the package");

if (failures.length > 0) {
  console.error(`check-skills: ${failures.length} problem(s)\n${failures.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-skills: ${skills.length} skills, ${projected.length} projected into generated projects (${projected.join(", ")})`);
