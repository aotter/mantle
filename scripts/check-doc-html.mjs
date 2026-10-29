// Markdown passes inline HTML through, so a bare `<word>` placeholder outside code becomes an unclosed element and
// breaks consumers that render the docs through Vue (VitePress). Fail on a lowercase opening tag outside code that the
// page never closes; void elements and self-closing tags are allowed. Write placeholders as `<word>` or &lt;word&gt;.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["docs", "skills", "packages/mantle/README.md", "packages/mantle-admin/README.md", "packages/mantle-ui/README.md", "README.md"];
const VOID = new Set(["br", "hr", "img", "wbr"]);
const SKIP = new Set(["node_modules", "dist", "generated", ".wrangler"]);

const walk = (path) => {
  let stat;
  try { stat = readdirSync(path, { withFileTypes: true }); } catch { return path.endsWith(".md") ? [path] : []; }
  return stat.flatMap((entry) => SKIP.has(entry.name) ? [] : entry.isDirectory() ? walk(join(path, entry.name)) : entry.name.endsWith(".md") ? [join(path, entry.name)] : []);
};

/** The page with fenced code, inline code spans and HTML comments blanked out; newlines are kept so line numbers stay true. */
export function prose(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const lines = text.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(lines[i])) fence = null;
      lines[i] = blank(lines[i]);
    } else if (open) { fence = open[1]; lines[i] = blank(lines[i]); }
  }
  return lines.join("\n")
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(`+)[\s\S]*?\1/g, (span) => span.includes("\n\n") ? span : blank(span));
}

/** Opening tags in prose that the page never closes: `{ line, tag }`. */
export function unclosedTags(text) {
  const body = prose(text), closed = new Set([...body.matchAll(/<\/([a-z][a-z0-9-]*)\s*>/g)].map((m) => m[1]));
  const found = [];
  for (const m of body.matchAll(/<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/g)) {
    const [whole, tag] = m;
    if (VOID.has(tag) || whole.endsWith("/>") || closed.has(tag)) continue;
    found.push({ line: body.slice(0, m.index).split("\n").length, tag: whole });
  }
  return found;
}

const SELF_TEST = [
  ["round <n> at <revision>", ["<n>", "<revision>"]],
  ["round `<n>` and &lt;n&gt;", []],
  ["```\n<n>\n```", []],
  ["~~~md\n| <commit> |\n~~~", []],
  ["<!-- <n> -->", []],
  ["<details><summary>x</summary>\n\nbody\n</details>", []],
  ["line<br>break <img src=a.png> <hr/>", []],
  ["<https://example.com> and <a@b.c>", []],
  ["<Component />", []],
];

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === "--self-test") {
  for (const [text, expected] of SELF_TEST) {
    const actual = unclosedTags(text).map((p) => p.tag);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`check-doc-html self-test: ${JSON.stringify(text)} gave ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`check-doc-html: self-test ${SELF_TEST.length} cases pass`);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const files = DIRS.flatMap((dir) => walk(join(ROOT, dir)));
  const problems = files.flatMap((file) => unclosedTags(readFileSync(file, "utf8")).map(({ line, tag }) => `${relative(ROOT, file)}:${line}: ${tag} is a bare placeholder; write it as \`${tag}\` or &lt;${tag.slice(1, -1)}&gt;`));
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`check-doc-html: ${problems.length} unclosed tag(s); Vue-based renderers (VitePress) fail on these pages.`);
    process.exit(1);
  }
  console.log(`check-doc-html: ${files.length} Markdown files, no bare placeholders outside code`);
}
