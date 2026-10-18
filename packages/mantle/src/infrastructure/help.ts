/** `mantle help [topic]`: a projection of the installed docs/handbook/navigation.json; the docs stay the only source. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Packed: <package>/docs. Workspace: the repository's docs/, which prepack copies in. */
export function docsRoot(): string {
  const pkg = packageRoot;
  const root = [resolve(pkg, "docs"), resolve(pkg, "../../docs")].find(path => existsSync(resolve(path, "handbook/navigation.json")));
  if (!root) throw new Error(`Mantle docs are missing from ${pkg}; reinstall @aotter/mantle.`);
  return root;
}

interface Topic { readonly name: string; readonly title: string; readonly file: string; readonly group: string }

export function topics(root = docsRoot()): Topic[] {
  const nav = JSON.parse(readFileSync(resolve(root, "handbook/navigation.json"), "utf8")) as { groups: { text: string; items: { text: string; link: string }[] }[] };
  const pages = nav.groups.flatMap(group => group.items.map(item => ({ name: item.link.slice(1), title: item.text, file: resolve(root, `handbook${item.link}.md`), group: group.text })));
  // Pages the sidebar leaves out (acceptance, release notes) are still topics.
  const listed = new Set(pages.map(page => page.file));
  const unlisted = (readdirSync(resolve(root, "handbook"), { recursive: true }) as string[]).filter(path => path.endsWith(".md")).sort()
    .map(path => resolve(root, "handbook", path)).filter(file => !listed.has(file))
    .map(file => ({ name: relative(resolve(root, "handbook"), file).replaceAll("\\", "/").slice(0, -3), title: readFileSync(file, "utf8").match(/^# (.+)$/m)?.[1] ?? basename(file), file, group: "More pages" }));
  const dirs = (path: string) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  const skills = dirs(resolve(root, "skills")).filter(name => existsSync(resolve(root, "skills", name, "SKILL.md")))
    .map(name => ({ name: `skills/${name}`, title: `Package skill: ${name}`, file: resolve(root, "skills", name, "SKILL.md"), group: "Package skills" }));
  const examples = resolve(root, "examples");
  const shipped = readdirSync(examples, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(resolve(examples, entry.name, "README.md")));
  return [...pages, ...unlisted, ...skills, { name: "examples", title: "Examples and how to combine them", file: resolve(examples, "README.md"), group: "Examples" },
    ...shipped.map(entry => ({ name: `examples/${entry.name}`, title: `Example: ${entry.name}`, file: resolve(examples, entry.name, "README.md"), group: "Examples" }))];
}

/** A full topic name, or its last segment when only one topic ends with it. */
function find(all: Topic[], name: string): Topic | undefined {
  const exact = all.find(topic => topic.name === name);
  if (exact) return exact;
  const tail = all.filter(topic => basename(topic.name) === name);
  return tail.length === 1 ? tail[0] : undefined;
}

export function help(name?: string, root = docsRoot()): string {
  const all = topics(root);
  const topic = find(all, name ?? "start/agents");
  if (!topic) {
    const near = all.filter(t => name && t.name.includes(name)).map(t => `  mantle help ${t.name}`);
    throw new Error(`No help topic ${JSON.stringify(name)}.${near.length ? `\nDid you mean:\n${near.join("\n")}` : ""}\nRun mantle help topics for the list.`);
  }
  const text = readFileSync(topic.file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  // Links to other topics become commands, so an agent can follow them without knowing the docs layout.
  const linked = [...new Set([...text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map(match => resolve(dirname(topic.file), match[1]!)))]
    .flatMap(file => all.filter(t => t.file === file && t !== topic));
  const index = all.indexOf(topic), next = all[index + 1]?.group === topic.group ? all[index + 1] : undefined;
  const lines = [text, "", `Source: ${relative(process.cwd(), topic.file) || topic.file}`];
  if (next) lines.push(`Next: mantle help ${next.name}  (${next.title})`);
  if (linked.length) lines.push("Linked:", ...linked.map(t => `  mantle help ${t.name}  (${t.title})`));
  if (!name) lines.push("", topicList(all));
  return lines.join("\n");
}

export function topicList(all = topics()): string {
  const groups = [...new Set(all.map(topic => topic.group))];
  return ["Topics:", ...groups.flatMap(group => [`  ${group}`, ...all.filter(t => t.group === group).map(t => `    ${t.name.padEnd(34)} ${t.title}`)])].join("\n");
}
