// Markdown passes inline HTML through, so a bare `<word>` outside code is an unclosed element and Vue-based renderers
// (VitePress) fail on the page. Fail on a lowercase opening tag outside code that the page never closes.
import { readFileSync, readdirSync } from "node:fs";

const VOID = new Set(["br", "hr", "img", "wbr"]);
const blank = (s) => s.replace(/[^\n]/g, " ");

/** Opening tags outside fenced code, inline code and comments that the page never closes. */
export function unclosedTags(text) {
  const prose = text.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, blank)
    .replace(/<!--[\s\S]*?-->/g, blank).replace(/(`+)[^`][\s\S]*?\1/g, blank);
  const closed = new Set([...prose.matchAll(/<\/([a-z][a-z0-9-]*)\s*>/g)].map((m) => m[1]));
  return [...prose.matchAll(/<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/g)]
    .filter(([tag, name]) => !VOID.has(name) && !tag.endsWith("/>") && !closed.has(name))
    .map((m) => `${prose.slice(0, m.index).split("\n").length}: ${m[0]}`);
}

// The original #1877 line must fail; code, comments, real HTML and autolinks must pass.
const bad = unclosedTags("round <n> at <revision>"), good = unclosedTags("`<n>` &lt;n&gt;\n```\n<n>\n```\n<!-- <n> --> <details>x</details> <br> <https://a.b>");
if (bad.length !== 2 || good.length) throw new Error(`check-doc-html self-test: ${JSON.stringify({ bad, good })}`);

const files = ["docs", "skills", "packages"].flatMap((dir) => readdirSync(dir, { recursive: true }).map((f) => `${dir}/${f}`))
  .filter((f) => f.endsWith(".md") && !/\/(node_modules|dist|generated)\//.test(f)).concat("README.md");
const problems = files.flatMap((f) => unclosedTags(readFileSync(f, "utf8")).map((p) => `${f}:${p} — write it as \`<word>\` or &lt;word&gt;`));
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`check-doc-html: ${files.length} Markdown files, no unclosed tags outside code`);
