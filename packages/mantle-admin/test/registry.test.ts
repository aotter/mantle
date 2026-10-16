import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { bothItems, items, pkg, sampleKey, slotSurface, source } from "./registry-items";

const allowed = new Set(["react", "@aotter/mantle-admin/app", "@aotter/mantle-admin/hooks"]);
const sources = items.flatMap(item => item.files.map(file => ({ item, file, text: source(file) })));

/** Every module specifier a file imports, re-exports, `import()`s or `require()`s. */
function specifiers(name: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [first] = node.arguments;
      found.push(first && ts.isStringLiteralLike(first) ? first.text : "<dynamic>");
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX));
  return found;
}

describe("registry items", () => {
  it("import only react and the public Admin entry points, or a file of the same item", () => {
    const own = new Set(sources.map(({ file }) => basename(file.path)));
    for (const { item, file, text } of sources) {
      for (const specifier of specifiers(file.path, text)) {
        const sibling = specifier.startsWith("./") && own.has(specifier.slice(2).replace(/\.js$/, ".tsx"));
        expect(allowed.has(specifier) || sibling, `${file.path} (${item.name}) imports ${specifier}`).toBe(true);
      }
    }
  });

  it("`both` items use no network call, credential storage, new window, absolute URL or Admin API path", () => {
    const forbidden: readonly [string, RegExp][] = [
      ["fetch(", /\bfetch\s*\(/],
      ["document.cookie", /document\.cookie/],
      ["localStorage", /localStorage/],
      ["window.open", /window\.open/],
      ['target="_blank"', /target\s*=\s*\{?\s*["'`]_blank/],
      ["/admin/api", /\/admin\/api/],
      ["an absolute URL in src/href", /\b(?:src|href)\s*=\s*\{?\s*["'`]\s*https?:/i],
      ["an absolute URL in url()", /url\(\s*["']?\s*https?:/i],
    ];
    expect(bothItems.length).toBeGreaterThan(0);
    for (const { item, text, file } of sources.filter(({ item }) => item.meta.surface === "both")) {
      for (const [label, pattern] of forbidden) expect(pattern.test(text), `${file.path} (${item.name}) contains ${label}`).toBe(false);
    }
  });

  it("declare their surface in the header comment, and it matches the slots they implement", () => {
    for (const { item, file, text } of sources) {
      const header = /^\/\*\*([\s\S]*?)\*\//.exec(text)?.[1] ?? "";
      expect(/Surface: (both|browser)\b/.exec(header)?.[1], `${file.path} header`).toBe(item.meta.surface);
      expect(/Slots: (.+)/.exec(header)?.[1]?.split(",").map(slot => slot.trim()), `${file.path} header slots`).toEqual([...item.meta.slots]);
      expect(item.meta.slots.length).toBeGreaterThan(0);
      for (const slot of item.meta.slots) expect(slotSurface(slot), `${item.name}: slot ${slot}`).toBe(item.meta.surface);
    }
  });

  it("typecheck as the components of defineAdmin against the built package", () => {
    const dir = resolve(pkg, "test/__registry");
    const virtual = new Map<string, string>();
    const imports: string[] = [], components: string[] = [];
    for (const { item, file, text } of sources) {
      const exported = /export function (\w+)/.exec(text)![1]!;
      virtual.set(resolve(dir, basename(file.path)), text);
      imports.push(`import { ${exported} } from "./${basename(file.path).replace(/\.tsx$/, ".js")}";`);
      for (const slot of item.meta.slots) components.push(`  ${JSON.stringify(sampleKey(slot))}: ${exported},`);
    }
    const consumer = resolve(dir, "consumer.ts");
    virtual.set(consumer, [`import { defineAdmin } from "@aotter/mantle-admin/app";`, ...imports, `export default defineAdmin({}, { components: {`, ...components, "} });"].join("\n"));
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: false, types: [] };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    const { directoryExists } = host;
    host.directoryExists = file => file === dir || (directoryExists?.(file) ?? false);
    host.fileExists = file => virtual.has(file) || fileExists(file);
    host.readFile = file => virtual.get(file) ?? readFile(file);
    host.getSourceFile = (file, language) => virtual.has(file) ? ts.createSourceFile(file, virtual.get(file)!, language) : getSourceFile(file, language);
    const program = ts.createProgram([...virtual.keys()], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => `${d.file ? basename(d.file.fileName) : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    expect(diagnostics).toEqual([]);
  });

  it("are built into dist/registry as registry items equal to registry.json and the sources", () => {
    const dist = resolve(pkg, "dist/registry");
    expect(readdirSync(dist).sort()).toEqual(items.map(item => `${item.name}.json`).sort());
    for (const item of items) {
      const built = JSON.parse(readFileSync(resolve(dist, `${item.name}.json`), "utf8"));
      expect(built.$schema).toBe("https://ui.shadcn.com/schema/registry-item.json");
      expect(built).toMatchObject({ name: item.name, type: "registry:component", meta: item.meta });
      expect(built.files).toEqual(item.files.map(file => ({ ...file, content: source(file) })));
    }
  });

  // The MCP App compatibility test loads the app-built MCP App in the host's AppBridge and checks each `both` item as an override.
  for (const item of bothItems) it.todo(`MCP App compatibility: ${item.name} renders in the Admin MCP App under AppBridge (${item.meta.slots.join(", ")})`);
});
