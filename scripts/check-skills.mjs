#!/usr/bin/env node
// skills/README.md: one consumer skill that routes to `mantle help` and holds no contract of its own.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const where = "skills/mantle/SKILL.md";
const failures = [];
const names = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (names.join() !== "mantle") failures.push(`skills/ must hold exactly one skill, mantle (found ${names.join(", ")})`);
if (existsSync(join(root, "docs", "skills"))) failures.push("docs/skills/ is gone: workflow guidance belongs in docs/handbook");

const text = readFileSync(join(root, where), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
const field = (key) => new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(front)?.[1].trim();
if (field("name") !== "mantle") failures.push(`${where}: name must be mantle`);
if (!field("description")) failures.push(`${where}: missing description`);
if (field("sourcePath") !== where) failures.push(`${where}: metadata.sourcePath must be ${where}`);
if (text.split("\n").length > 40) failures.push(`${where}: over the 40-line budget; move the detail into the handbook`);
if (/\b\d+\.\d+\.\d+/.test(text)) failures.push(`${where}: names a version; the installed package decides it`);
if (/\]\((?!https?:)/.test(text)) failures.push(`${where}: relative links do not ship with the skill; name a mantle help topic`);

// Every topic the skill names must resolve the way `mantle help` resolves it: a handbook path or its unique last segment.
const handbook = join(root, "docs", "handbook");
const pages = readdirSync(handbook, { recursive: true }).filter((path) => path.endsWith(".md")).map((path) => path.replaceAll("\\", "/").slice(0, -3));
for (const [, topic] of text.matchAll(/mantle help ([a-z0-9./-]*[a-z0-9/-])/g)) {
  if (topic === "topics" || pages.includes(topic)) continue;
  if (pages.filter((page) => page.split("/").at(-1) === topic).length !== 1) failures.push(`${where}: mantle help ${topic} is not a topic`);
}

if (failures.length > 0) {
  console.error(`check-skills: ${failures.length} problem(s)\n${failures.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("check-skills: one skill (mantle)");
