/**
 * What a seam's consumer module may contain (application-seams.ts): the shape of hand-written application code, so a
 * seam that only works through plumbing or a cast does not count as kept. Shared by the Core and Admin seam tests.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../../..");
const packages: Record<string, string> = {
  "@aotter/mantle": resolve(root, "packages/mantle"),
  "@aotter/mantle-admin": resolve(root, "packages/mantle-admin"),
};
const exportsOf = (name: string) =>
  JSON.parse(readFileSync(resolve(packages[name]!, "package.json"), "utf8")).exports as Record<string, unknown>;

/**
 * The problems in one consumer module: an `@aotter/*` import that does not resolve through its package's exports map
 * to `dist` by a key outside `./internal/`, a relative import out of the module's directory, a computed `import()` or
 * `require`, and any cast: `as` (except `as const`), `<T>x`, `x!`, an `any` type or a `@ts-` directive.
 */
export function consumerProblems(file: string, options: ts.CompilerOptions): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (node: ts.Node) =>
    `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  if (/@ts-(?:nocheck|ignore|expect-error)/.test(text)) problems.push(`${relative(root, file)}: a @ts- directive`);
  const specifier = (node: ts.Node, value: string) => {
    if (value.startsWith(".")) {
      const target = resolve(dirname(file), value);
      if (!target.startsWith(dirname(file) + sep))
        problems.push(`${at(node)}: relative import out of its directory: ${value}`);
      return;
    }
    const name = Object.keys(packages).find(pkg => value === pkg || value.startsWith(pkg + "/"));
    if (!name) return; // a third-party package the application installs itself
    const key = "." + value.slice(name.length);
    if (key.startsWith("./internal/") || !(key in exportsOf(name))) {
      problems.push(`${at(node)}: ${value} is not a public subpath of ${name}`);
      return;
    }
    const resolved = ts.resolveModuleName(value, file, options, ts.sys).resolvedModule?.resolvedFileName ?? "";
    if (!resolved.startsWith(resolve(packages[name]!, "dist") + sep))
      problems.push(
        `${at(node)}: ${value} does not resolve to ${name}'s dist through its exports map (${resolved || "unresolved"})`,
      );
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      specifier(node, (node.moduleSpecifier as ts.StringLiteral).text);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifier(node, argument.text);
      else problems.push(`${at(node)}: a computed import`);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      specifier(node, node.argument.literal.text);
    else if (
      ts.isAsExpression(node) &&
      !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "const")
    )
      problems.push(`${at(node)}: a cast (as ${node.type.getText()})`);
    else if (ts.isTypeAssertionExpression(node)) problems.push(`${at(node)}: a cast (<${node.type.getText()}>)`);
    else if (ts.isNonNullExpression(node)) problems.push(`${at(node)}: a non-null assertion`);
    else if (node.kind === ts.SyntaxKind.AnyKeyword) problems.push(`${at(node)}: an any type`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
