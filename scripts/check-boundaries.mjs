#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

checkRuntimeCloudflareFree();
checkPackageDirection();
checkSkillDocsVersioned();

if (failures.length > 0) {
  console.error("Boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Boundary check passed.");
