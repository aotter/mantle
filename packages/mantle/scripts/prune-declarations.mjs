/** Keep the public declaration closure; inline only its private compiler types. */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, ".."), dist = join(root, "dist");
const compiler = join(dist, "build/compiler.d.ts");
const exports = Object.values(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports).filter(target => typeof target === "string" && target.endsWith(".js"));
const keep = new Set(), pending = exports.map(target => resolve(root, target.replace(/\.js$/, ".d.ts")));
while (pending.length) {
  const file = pending.pop();
  if (keep.has(file)) continue;
  keep.add(file);
  if (file === compiler) continue;
  for (const [, path] of readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) pending.push(resolve(dirname(file), path.replace(/\.js$/, ".d.ts")));
}

// Resolve aliases with TypeScript itself rather than retaining a barrel's unrelated exports.
if (keep.has(compiler)) {
  const program = ts.createProgram([...keep], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker(), statements = new Set(), seen = new Set(), symbols = [], shipped = new Map();
  const unalias = symbol => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const inBuild = node => node.getSourceFile().fileName.startsWith(join(dist, "build") + "/");
  const references = node => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) symbols.push(unalias(symbol));
    }
    ts.forEachChild(node, references);
  };
  for (const file of keep) if (file !== compiler) references(program.getSourceFile(file));
  while (symbols.length) {
    const symbol = symbols.pop();
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (!inBuild(declaration)) continue;
      const source = declaration.getSourceFile();
      if (source.fileName !== compiler && keep.has(source.fileName)) {
        // Already shipped with its JSDoc: re-export it instead of declaring a second copy.
        if (checker.getExportsOfModule(checker.getSymbolAtLocation(source)).includes(symbol)) shipped.set(symbol.name, source.fileName);
        continue;
      }
      let statement = declaration;
      while (!ts.isSourceFile(statement.parent)) statement = statement.parent;
      if (statements.has(statement)) continue;
      statements.add(statement);
      references(statement);
    }
  }
  const printer = ts.createPrinter({ removeComments: true });
  const text = [...statements].map(statement => {
    const result = ts.transform(statement, [context => {
      const visit = node => {
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node);
          if (symbol?.flags & ts.SymbolFlags.Alias) return ts.factory.createIdentifier(unalias(symbol).name);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit);
    }]);
    const declaration = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], statement.getSourceFile());
    result.dispose();
    return declaration;
  }).join("\n");
  const modules = Map.groupBy(shipped.keys(), name => `./${relative(dirname(compiler), shipped.get(name)).replace(/\.d\.ts$/, ".js")}`);
  const reexports = [...modules].map(([path, names]) => `import { ${names.join(", ")} } from "${path}";\nexport { ${names.join(", ")} };\n`).join("");
  writeFileSync(compiler, reexports + text + "\n");
  // Catch missing references and conflicting names in the flattened declarations.
  const declarations = ts.createProgram([compiler], { noEmit: true, types: [], strict: true, target: ts.ScriptTarget.ES2022 });
  const diagnostics = ts.getPreEmitDiagnostics(declarations);
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
}
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
for (const file of walk(dist)) if (file.endsWith(".d.ts") && !keep.has(file)) rmSync(file);
