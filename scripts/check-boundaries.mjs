#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

const failures = [];

function listFiles(dir, predicate) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) files.push(path);
  }
  return files;
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

/** The browser package stays host- and framework-neutral where it promises to (ADR-0029). */
function checkUiTokens() {
  const rules = [
    ["packages/mantle-ui/src/controller", ["window.", "document.", "localStorage", "sessionStorage"], "ui controller must stay framework- and host-free"],
    ["packages/mantle-ui/src/react", ["@aotter/mantle/admin", "@tanstack/", "@modelcontextprotocol/", "fetch(", "location.", "localStorage", "document.cookie"], "ui components must not depend on Admin, a query cache, a transport or host globals"],
    ["packages/mantle-ui/src/kit", ["@aotter/", "@tanstack/", "@modelcontextprotocol/", "fetch(", "localStorage", '"@/'], "ui kit must stay domain-neutral: no Mantle packages, query cache, transport, storage or Admin aliases"],
  ];
  for (const [dir, forbidden, message] of rules) {
    for (const file of listFiles(join(ROOT, dir), (p) => p.endsWith(".ts") || p.endsWith(".tsx"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const token of forbidden) if (source.includes(token)) fail(file, `${message}: '${token}'`);
    }
  }
}

/** Core holds no engine or platform code (ADR-0035 decision 3): no Cloudflare primitive appears in `src/core`. */
function checkCoreCloudflareFree() {
  for (const file of listFiles(join(ROOT, "packages/mantle/src/core"), (p) => p.endsWith(".ts"))) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const token of ["@cloudflare/", "cloudflare:", "D1Database", "KVNamespace", "R2Bucket", "ExecutionContext", "Bun.", "bun:"]) {
      if (source.includes(token)) fail(file, `core must not reference Cloudflare primitive '${token}'`);
    }
  }
}

/**
 * packages/mantle/README.md: every folder of src is one subpath and reaches only the folders it needs, and a heavy library belongs to the one
 * folder that is its integration (ADR-0032 decision 13, enforced per module now that there is one package): a folder that is not
 * `auth` may not import Better Auth, one that is not `mcp` may not import the MCP SDK, and so on.
 */
function checkNextFolderImports() {
  // Core holds no engine code (ADR-0035 decision 3): SQLite lives in `d1`, and only `spec`'s front end (the built-in
  // dialect's compile side), `cloudflare` and `cli` reach it. `testing` runs over the dialect interface. `postgres` reuses
  // the SQLite dialect's subset check and codecs, and `cli` loads its compile side as a built-in (ADR-0036).
  const folders = { core: ["spec"], spec: ["d1/compile"], d1: ["core", "spec"], postgres: ["core", "spec", "d1"], testing: ["core", "spec"], cloudflare: ["core", "spec", "d1"], bun: ["core", "spec", "postgres", "d1"], auth: ["core", "spec", "admin"], admin: ["core", "spec"], mcp: ["core", "spec"], web: ["core", "spec"], cli: ["core", "spec", "d1", "postgres/compile"] };
  const libs = { "better-auth": "auth", "@better-auth/": "auth", "@modelcontextprotocol/": "mcp", "hono": "web", "@cloudflare/": "cloudflare", "wrangler": "cloudflare", "react": "admin", "libpg-query": "spec", "pgsql-deparser": ["d1", "postgres"] };
  const NODE_ALLOWED = { auth: ["node:async_hooks"], testing: ["node:util"], bun: ["node:path", "node:fs/promises"] };
  const root = join(ROOT, "packages/mantle/src");
  for (const [folder, reach] of Object.entries(folders)) {
    for (const file of listFiles(join(root, folder), (p) => p.endsWith(".ts") || p.endsWith(".tsx"))) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        if (spec.startsWith(".")) {
          const path = relative(root, join(dirname(file), spec)).split(sep);
          const target = path[0];
          if (target !== folder && !reach.some((r) => r.split("/").every((part, i) => path[i] === part))) fail(file, `src/${folder} may reach only ${[folder, ...reach].join(", ")}: '${spec}'`);
          else if (folder === "spec" && target === "d1" && !relative(root, file).startsWith(`spec${sep}infrastructure${sep}`)) fail(file, `only the CLI front end (src/spec/infrastructure) may reach src/d1/compile: '${spec}'`);
          // ADR-0034 decision 3: only Node code compiles SQL; the spec barrel re-exports the compiler, so a Worker bundle would carry libpg-query
          else if (target === "spec" && !["spec", "cli", "testing"].includes(folder) && (path[1] === "index.ts" || path[1] === "index.js" || path[1] === "infrastructure")) fail(file, `src/${folder} runs in the Worker: import src/spec/domain or src/spec/kernel, not '${spec}', which carries the SQL compiler`);
        } else if (spec.startsWith("node:")) {
          // Workers run a subset of Node: only the CLI is Node, plus the two built-ins workerd provides that auth and the suite use
          if (folder !== "cli" && !(NODE_ALLOWED[folder] ?? []).includes(spec)) fail(file, `src/${folder} may not import '${spec}': only the CLI runs on Node`);
        } else {
          for (const [prefix, owner] of Object.entries(libs)) {
            if ((spec === prefix || spec.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) && ![owner].flat().includes(folder)) fail(file, `only src/${[owner].flat().join(", src/")} may import '${spec}'`);
          }
        }
      }
    }
  }
}

/** The UI controller imports nothing: its Mantle shapes are structural,
 *  so it installs and bundles alone. Checked on the AST, so re-exports,
 *  side-effect and dynamic imports count too. */
function checkUiControllerImports() {
  const files = listFiles(join(ROOT, "packages/mantle-ui/src/controller"), (p) => p.endsWith(".ts"));
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const specifiers = [];
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specifiers.push(node.arguments[0].text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifiers.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers.filter((value) => !value.startsWith("."))) {
      fail(file, `ui controller must not import '${specifier}'`);
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

function checkRepositoryGuidance() {
  const agentsPath = join(ROOT, "AGENTS.md");
  const claudePath = join(ROOT, "CLAUDE.md");
  const contributingPath = join(ROOT, "CONTRIBUTING.md");
  const releaseSkillPath = join(ROOT, ".agents/skills/mantle-release/SKILL.md");
  const claudeReleasePath = join(ROOT, ".claude/skills/mantle-release/SKILL.md");
  const agents = readFileSync(agentsPath, "utf8");
  const claude = readFileSync(claudePath, "utf8");
  const contributing = readFileSync(contributingPath, "utf8");
  const releaseSkill = readFileSync(releaseSkillPath, "utf8");
  const claudeRelease = readFileSync(claudeReleasePath, "utf8");

  if (!agents.includes("CONTRIBUTING.md") || agents.split("\n").length > 30) {
    fail(agentsPath, "AGENTS.md must remain a small router to CONTRIBUTING.md");
  }
  if (!claude.includes("CONTRIBUTING.md") || claude.split("\n").length > 12) {
    fail(claudePath, "CLAUDE.md must remain a small compatibility pointer");
  }
  for (const heading of ["Mantle thesis", "Hard invariants", "Clean architecture", "Build / test"]) {
    if (claude.includes(heading)) {
      fail(claudePath, `duplicate contributor guidance returned: '${heading}'`);
    }
  }
  for (const text of [
    "Mantle Core is an embeddable manifest engine",
    "ManifestSourceSet -> parse",
    "human engineers",
    "skills/*",
  ]) {
    if (!contributing.includes(text)) {
      fail(contributingPath, `contributor authority is missing '${text}'`);
    }
  }
  if (!releaseSkill.includes("Both npmjs artifacts")) {
    fail(releaseSkillPath, "canonical release skill must match the two-package topology");
  }
  if (!claudeRelease.includes("../../../.agents/skills/mantle-release/SKILL.md") ||
      claudeRelease.split("\n").length > 8 ||
      /^## (?:Contract|Prepare|Run|Recovery)/m.test(claudeRelease)) {
    fail(claudeReleasePath, "Claude release entry must only point to the canonical skill");
  }

  for (const stalePath of [
    "starters",
    "starters/blank/README.md",
    "packages/adapters/netlify/README.md",
    "packages/adapters/netlify/package.json",
  ]) {
    const path = join(ROOT, stalePath);
    if (existsSync(path)) fail(path, "obsolete repository stub remains");
  }

  const activeDocs = [
    agentsPath,
    claudePath,
    contributingPath,
    join(ROOT, "README.md"),
    join(ROOT, "skills/README.md"),
    ...listFiles(join(ROOT, "packages"), (path) => path.endsWith("README.md")),
    ...listFiles(join(ROOT, "docs"), (path) =>
      path.endsWith(".md") &&
      !path.includes(`${sep}adr${sep}`) &&
      !path.endsWith("sealed-pipeline-ownership.md")
    ),
  ];
  for (const path of activeDocs) {
    const source = readFileSync(path, "utf8");
    for (const token of [
      "CmsRuntime",
      "bindMantleSite",
      "MantleSite",
      "createCmsRuntime",
      "site.ts",
      "@aotter/mantle-netlify",
      "packages/adapters/netlify",
      "starters/blank",
    ]) {
      if (source.includes(token)) fail(path, `obsolete active-doc reference remains: '${token}'`);
    }
  }

  const rootReadmePath = join(ROOT, "README.md");
  const rootReadme = readFileSync(rootReadmePath, "utf8");
  const releaseWorkflowPath = join(ROOT, ".github/workflows/release.yml");
  const releaseWorkflow = readFileSync(releaseWorkflowPath, "utf8");
  const codeownersPath = join(ROOT, ".github/CODEOWNERS");
  const codeowners = readFileSync(codeownersPath, "utf8");
  const publicPackages = listFiles(join(ROOT, "packages"), (path) =>
    path.endsWith("package.json"),
  ).map((path) => ({
    path,
    dir: rel(dirname(path)),
    manifest: JSON.parse(readFileSync(path, "utf8")),
  })).filter(({ manifest }) => !manifest.private);
  for (const { path, dir, manifest } of publicPackages) {
    if (!rootReadme.includes(`\`${manifest.name}\``)) {
      fail(rootReadmePath, `package map is missing '${manifest.name}'`);
    }
    if (!releaseWorkflow.includes(`        ${dir}`)) {
      fail(releaseWorkflowPath, `release package order is missing '${dir}'`);
    }
    if (!codeowners.includes(`/${dir}/`)) {
      fail(codeownersPath, `package ownership is missing '/${dir}/'`);
    }
    if (!existsSync(join(dirname(path), "README.md"))) {
      fail(path, "public package is missing its installed-consumer README");
    }
  }

  for (const relativePath of [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".copilot-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ]) {
    const path = join(ROOT, relativePath);
    const source = readFileSync(path, "utf8");
    if (/Mantle sites|ship[^\n"]*Cloudflare/i.test(source)) {
      fail(path, "plugin metadata must describe embeddable, multi-runtime Mantle");
    }
  }
}

checkCoreCloudflareFree();
checkUiTokens();
checkNextFolderImports();
checkUiControllerImports();
checkSkillDocsVersioned();
checkRepositoryGuidance();

if (failures.length) {
  console.error("Boundary check failed:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("Boundary check passed.");
