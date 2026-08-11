#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

const failures = [];

function listFiles(dir, predicate) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (path) =>
        !relative(dir, path)
          .split(sep)
          .some((seg) => seg === "node_modules" || seg === "dist") &&
        predicate(path),
    );
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function rel(path) {
  return relative(ROOT, path);
}

function fail(path, message) {
  failures.push(`${rel(path)}: ${message}`);
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function hasDatabasePropertyAccess(source, fileName = "boundary-fixture.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;

  function visit(node) {
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "db") ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "db") ||
      (ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        propertyNameText(node.propertyName ?? node.name) === "db")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function checkDatabasePropertyDetector() {
  const fixtures = [
    ["property access", "const raw = runtime.db;", true],
    ["element access", 'const raw = runtime["db"];', true],
    ["destructuring", "const { db: raw } = runtime;", true],
    ["string literal", 'const note = "runtime.db";', false],
  ];
  for (const [name, source, expected] of fixtures) {
    if (hasDatabasePropertyAccess(source) !== expected) {
      throw new Error(`Database boundary detector failed its ${name} fixture`);
    }
  }
}

function checkRuntimeCloudflareFree() {
  const forbidden = [
    "@cloudflare/",
    "@cloudflare/workers-types",
    "D1Database",
    "KVNamespace",
    "Fetcher",
    "ExecutionContext",
  ];
  const files = listFiles(join(ROOT, "packages/mantle-runtime/src"), (p) =>
    p.endsWith(".ts"),
  );
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const token of forbidden) {
      const pattern = token.startsWith("@")
        ? token
        : new RegExp(`\\b${token}\\b`);
      if (
        typeof pattern === "string"
          ? source.includes(pattern)
          : pattern.test(source)
      ) {
        fail(file, `runtime must not reference Cloudflare primitive '${token}'`);
      }
    }
  }
}

function checkPackageDirection() {
  const rules = [
    {
      dir: "packages/mantle-spec/src",
      forbidden: [
        "@aotter/mantle-runtime",
        "@aotter/mantle-cloudflare",
      ],
      message: "spec must not import runtime/cloudflare packages",
    },
    {
      dir: "packages/mantle-runtime/src",
      forbidden: [
        "@aotter/mantle-cloudflare",
        "@aotter/mantle-netlify",
      ],
      message: "runtime must not import adapter packages",
    },
  ];

  for (const rule of rules) {
    const files = listFiles(join(ROOT, rule.dir), (p) => p.endsWith(".ts"));
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const token of rule.forbidden) {
        if (source.includes(token)) {
          fail(file, `${rule.message}: '${token}'`);
        }
      }
    }
  }
}

function checkEntryReadOwnership() {
  const runtimeReadDirs = [
    "packages/mantle-runtime/src/domain/service/io",
    "packages/mantle-runtime/src/usecase/render",
  ];
  for (const dir of runtimeReadDirs) {
    const files = listFiles(join(ROOT, dir), (path) => path.endsWith(".ts"));
    for (const file of files) {
      if (/\bDatabaseDriver\b/.test(stripComments(readFileSync(file, "utf8")))) {
        fail(file, "entry/render reads must depend on EntryReader, not DatabaseDriver");
      }
    }
  }

  const adapterFiles = listFiles(
    join(ROOT, "packages/adapters/cloudflare/src"),
    (path) => path.endsWith(".ts"),
  );
  const mantleTableSql =
    /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+(?:entries|site_config)\b/i;
  for (const file of adapterFiles) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (mantleTableSql.test(source)) {
      fail(file, "Cloudflare routes must not own Mantle entries/site_config SQL");
    }
  }

  const mountDir = join(ROOT, "packages/adapters/cloudflare/src/mount");
  const mountFiles = listFiles(
    mountDir,
    (path) => path.endsWith(".ts") && !path.endsWith("bootRuntimeOnce.ts"),
  );
  for (const file of mountFiles) {
    if (hasDatabasePropertyAccess(readFileSync(file, "utf8"), file)) {
      fail(file, "Cloudflare route mounts must not access a raw database property");
    }
  }
}

function checkNodeTestingBoundary() {
  const root = join(ROOT, "packages/mantle-runtime/src");
  const files = listFiles(root, (path) => path.endsWith(".ts"));
  for (const file of files) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (
      source.includes("node:sqlite") &&
      !file.includes(`${sep}infrastructure${sep}testing${sep}`)
    ) {
      fail(file, "node:sqlite belongs only in the explicit runtime/testing subpath");
    }
  }
  const main = join(root, "index.ts");
  if (/testing(?:\/index)?\.js/.test(stripComments(readFileSync(main, "utf8")))) {
    fail(main, "the Worker-safe runtime entry must not re-export the Node testing harness");
  }
  const specMain = join(ROOT, "packages/mantle-spec/src/index.ts");
  if (/from\s+["']\.\/infrastructure\/cli/.test(stripComments(readFileSync(specMain, "utf8")))) {
    fail(specMain, "the pure spec entry must not re-export its Node CLI subpath");
  }
}

function checkSkillDocsVersioned() {
  const files = listFiles(join(ROOT, "skills"), (path) =>
    path.endsWith("SKILL.md"),
  );
  const floatingCoreDoc =
    /(?:raw\.githubusercontent\.com\/aotter\/mantle\/develop|github\.com\/aotter\/mantle\/(?:blob|raw)\/develop)\//;
  for (const file of files) {
    if (floatingCoreDoc.test(readFileSync(file, "utf8"))) {
      fail(
        file,
        "consumer skills must use the installed Mantle docs, not floating develop docs",
      );
    }
  }
}

checkDatabasePropertyDetector();
checkRuntimeCloudflareFree();
checkPackageDirection();
checkEntryReadOwnership();
checkNodeTestingBoundary();
checkSkillDocsVersioned();

if (failures.length > 0) {
  console.error("Boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Boundary check passed.");
