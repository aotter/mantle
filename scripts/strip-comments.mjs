#!/usr/bin/env node
/** Remove comments from the JavaScript tsc emits; code bytes, annotations and the `.d.ts` JSDoc stay. */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

// Bundler annotations, legal comments and the shebang mean something to tools; every other comment is prose.
const keep = /[@#]__(PURE|NO_SIDE_EFFECTS)__|^\/\*!|@vite-ignore|webpackIgnore|@license|@preserve|^#!/;
const config = ts.getParsedCommandLineOfConfigFile(process.argv[2] ?? "tsconfig.lib.json", {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); } });
const outputs = config.fileNames.flatMap(file => ts.getOutputFileNames(config, file, !ts.sys.useCaseSensitiveFileNames)).filter(file => /\.[cm]?js$/.test(file));

for (const file of outputs) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // Comment ranges come from token trivia, so comment-like text in strings, templates and regexps is never touched.
  const comments = new Map();
  const collect = ranges => { for (const range of ranges ?? []) comments.set(range.pos, range); };
  const visit = node => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  let out = "", cursor = 0;
  for (const { pos, end } of [...comments.values()].sort((a, b) => a.pos - b.pos)) {
    const comment = text.slice(pos, end);
    if (pos < cursor || keep.test(comment)) continue;
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1, lineEnd = end === text.length ? end : text.indexOf("\n", end);
    const before = text.slice(Math.max(lineStart, cursor), pos), after = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
    let from = pos, to = end, replacement = "";
    if (/^[ \t]*$/.test(after)) {
      // Alone on its line: drop the line. At a line's end: drop the spaces before it.
      from = /^[ \t]*$/.test(before) && lineStart >= cursor ? lineStart : pos - before.match(/[ \t]*$/)[0].length;
      to = from === lineStart && lineEnd !== -1 && lineEnd < text.length ? lineEnd + 1 : end + after.length;
    } else if (comment.includes("\n")) replacement = "\n"; // keeps automatic semicolon insertion unchanged
    else if (!/\s/.test(text[pos - 1] ?? " ") && !/\s/.test(text[end] ?? " ")) replacement = " ";
    out += text.slice(cursor, from) + replacement;
    cursor = to;
  }
  out += text.slice(cursor);
  if (out !== text) writeFileSync(file, out);
}
