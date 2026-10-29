#!/usr/bin/env node
// Enforces the disclosure audit in skills/README.md: front matter is the only
// distribution authority, the audit table states the same distribution and
// reason, and every reference resolves wherever the skill is read.
//
// ADR-0032 decision 13, amended 2026-10-29 (#1817): the plugin's `mantle` entry
// skill under skills/, and the package skills under docs/skills/ (shipped in
// @aotter/mantle's docs/, and installable by name from GitHub through
// .claude-plugin/plugin.json). Any skill folder may be copied on its own, so a
// relative link stays inside it; the handbook is named as `mantle help <topic>`.
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
const markdownFiles = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  const file = join(path, entry.name);
  return entry.isDirectory() ? markdownFiles(file) : entry.isFile() && entry.name.endsWith(".md") ? [file] : [];
});
const repoPath = (path) => relative(repoRoot, path).split(sep).join("/");

// skill -> { file, projection it must declare }
const skills = new Map();
for (const name of directories(join(repoRoot, "skills"))) {
  skills.set(name, { where: `skills/${name}/SKILL.md`, projection: "plugin" });
}
for (const name of directories(join(repoRoot, "docs", "skills"))) {
  const where = `docs/skills/${name}/SKILL.md`;
  if (skills.has(name)) fail(where, `skill name ${name} is already shipped by ${skills.get(name).where}`);
  else skills.set(name, { where, projection: "package" });
}
if (skills.get("mantle")?.projection !== "plugin") fail("skills/", "the plugin's entry skill is skills/mantle");

// `mantle help` topics, as packages/mantle/src/infrastructure/help.ts names them.
const docs = join(repoRoot, "docs");
const topics = [
  ...markdownFiles(join(docs, "handbook")).map((file) => relative(join(docs, "handbook"), file).split(sep).join("/").slice(0, -3)),
  ...directories(join(docs, "skills")).map((name) => `skills/${name}`),
  "examples",
  ...directories(join(docs, "examples")).filter((name) => existsSync(join(docs, "examples", name, "README.md"))).map((name) => `examples/${name}`),
];
const isTopic = (name) => topics.includes(name) || topics.filter((topic) => topic.split("/").at(-1) === name).length === 1;

const declared = new Map();
for (const [name, { where, projection }] of skills) {
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
  if (!front("applies_to")) fail(where, "metadata.applies_to must name the SDK versions the skill applies to");
  declared.set(name, { projection: front("projection"), reason: front("projectionReason") });

  const skillDirectory = dirname(file);
  const edges = new Map();
  for (const markdown of markdownFiles(skillDirectory)) {
    const markdownWhere = repoPath(markdown);
    const targets = [];
    const text = readFileSync(markdown, "utf8");
    for (const [, topic] of text.matchAll(/`(?:npx )?mantle help ([a-z0-9][a-z0-9/-]*)`/g)) {
      if (!isTopic(topic)) fail(markdownWhere, `no help topic: mantle help ${topic}`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = resolve(dirname(markdown), target.split("#")[0]);
      if (!existsSync(path)) fail(markdownWhere, `dead link: ${target}`);
      // a link that leaves the skill folder resolves here and is missing wherever the folder is copied
      else if (relative(skillDirectory, path).startsWith("..")) fail(markdownWhere, `link leaves the skill folder (use \`mantle help <topic>\`): ${target}`);
      else if (path.endsWith(".md")) targets.push(path);
    }
    edges.set(markdown, targets);
  }
  const reachable = new Set([file]);
  for (const pending = [file]; pending.length > 0;) {
    for (const target of edges.get(pending.pop()) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        pending.push(target);
      }
    }
  }
  for (const markdown of edges.keys()) {
    if (!reachable.has(markdown)) fail(repoPath(markdown), `not referenced from ${where}`);
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
