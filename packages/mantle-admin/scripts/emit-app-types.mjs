#!/usr/bin/env node
// Declarations for `@aotter/mantle-admin/app`, one public module at a time (isolated declarations), so the
// published types never reach into Admin's internal modules.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const src = resolve(import.meta.dirname, "../admin/src/app");
const out = resolve(import.meta.dirname, "../dist/admin-app");
const modules = ["index.ts", "define-admin.ts", "mantle-admin.tsx"];
const failures = [];
for (const file of modules) {
  const { outputText, diagnostics } = ts.transpileDeclaration(readFileSync(resolve(src, file), "utf8"), {
    fileName: file,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  for (const d of diagnostics ?? []) failures.push(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  for (const [, spec] of outputText.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (spec.startsWith(".") && !modules.some(m => spec === `./${m.replace(/\.tsx?$/, "")}`)) failures.push(`${file}: public types import internal module ${spec}`);
  }
  // The JS is one bundle, so each sibling declaration is addressed as a file for NodeNext consumers.
  writeFileSync(resolve(out, file.replace(/\.tsx?$/, ".d.ts")), outputText.replace(/(from\s+["']\.\/[\w-]+)(["'])/g, "$1.js$2"));
}
if (failures.length) throw new Error(failures.join("\n"));
console.log("admin-app declarations written");
