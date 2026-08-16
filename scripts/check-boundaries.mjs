#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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
        "@aotter/mantle-web",
        "@aotter/mantle-admin",
        "@aotter/mantle-admin-ui",
        "@aotter/mantle-bun",
        "@aotter/mantle-vercel",
      ],
      message: "spec must not import runtime, optional product, or adapter packages",
    },
    {
      dir: "packages/mantle-runtime/src",
      forbidden: [
        "@aotter/mantle-cloudflare",
        "@aotter/mantle-admin-ui",
        "@aotter/mantle-web",
        "@aotter/mantle-admin",
        "@aotter/mantle-admin-ui",
        "@aotter/mantle-bun",
        "@aotter/mantle-vercel",
      ],
      message: "runtime must not import optional product or adapter packages",
    },
    {
      dir: "packages/mantle-web/src",
      forbidden: [
        "@aotter/mantle-cloudflare",
        "@aotter/mantle-admin",
        "@aotter/mantle-admin-ui",
        "@aotter/mantle-bun",
        "@aotter/mantle-vercel",
        "D1Database",
        "KVNamespace",
        "ExecutionContext",
      ],
      message: "web must not import platform or admin packages and types",
    },
    {
      dir: "packages/mantle-admin/src",
      forbidden: [
        "@aotter/mantle-cloudflare",
        "@aotter/mantle-bun",
        "@aotter/mantle-vercel",
        "D1Database",
        "KVNamespace",
        "ExecutionContext",
      ],
      message: "admin must not import platform packages and types",
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
    "packages/mantle-web/src/usecase",
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

function checkWebPackageBoundary() {
  const runtimePath = join(ROOT, "packages/mantle-runtime/package.json");
  const webPath = join(ROOT, "packages/mantle-web/package.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  const web = JSON.parse(readFileSync(webPath, "utf8"));
  const runtimeDeps = { ...runtime.dependencies, ...runtime.optionalDependencies };
  if (runtimeDeps["@aotter/mantle-web"]) {
    fail(runtimePath, "runtime must stay installable without Mantle Web");
  }
  if (!web.dependencies?.["@aotter/mantle-runtime"]) {
    fail(webPath, "Mantle Web must depend downstream on Mantle Runtime");
  }
  const runtimeSource = listFiles(
    join(ROOT, "packages/mantle-runtime/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  for (const token of [
    "TemplateRegistry",
    "PublicPathResolver",
    "renderEntryHtml",
    "serializeEntryAsMarkdown",
    "composePageSeoMeta",
  ]) {
    if (runtimeSource.includes(token)) {
      fail(runtimePath, `Web-owned surface leaked back into runtime: '${token}'`);
    }
  }
}

function checkAdminPackageBoundary() {
  const runtimePath = join(ROOT, "packages/mantle-runtime/package.json");
  const adminPath = join(ROOT, "packages/mantle-admin/package.json");
  const cloudflarePath = join(ROOT, "packages/adapters/cloudflare/package.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  const admin = JSON.parse(readFileSync(adminPath, "utf8"));
  const cloudflare = JSON.parse(readFileSync(cloudflarePath, "utf8"));
  const runtimeDeps = { ...runtime.dependencies, ...runtime.optionalDependencies };
  if (runtimeDeps["@aotter/mantle-admin"] || runtimeDeps["@aotter/mantle-admin-ui"]) {
    fail(runtimePath, "runtime must stay installable without Mantle Admin or its UI");
  }
  if (!admin.dependencies?.["@aotter/mantle-runtime"]) {
    fail(adminPath, "Mantle Admin must compose downstream from Runtime");
  }
  if (admin.dependencies?.["@aotter/mantle-admin-ui"]) {
    fail(adminPath, "Mantle Admin API must stay installable without the Admin UI");
  }
  if (!cloudflare.dependencies?.["@aotter/mantle-admin"]) {
    fail(cloudflarePath, "Cloudflare must select Mantle Admin explicitly");
  }
  if (cloudflare.dependencies?.["@aotter/mantle-admin-ui"]) {
    fail(cloudflarePath, "Cloudflare must select Mantle Admin, not depend on its UI directly");
  }
  const runtimeSource = listFiles(
    join(ROOT, "packages/mantle-runtime/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  if (/from\s+["'][^"']*mantle-admin(?:-ui)?[^"']*["']/.test(runtimeSource)) {
    fail(runtimePath, "runtime source cannot import Mantle Admin or its UI");
  }
  const adminSource = listFiles(
    join(ROOT, "packages/mantle-admin/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  if (/from\s+["'][^"']*mantle-(?:cloudflare|bun|vercel)[^"']*["']/.test(adminSource) ||
      /\b(?:D1Database|ExecutionContext)\b/.test(adminSource)) {
    fail(adminPath, "Mantle Admin cannot import platform packages or types");
  }
}

function checkUmbrellaPackageBoundary() {
  const path = join(ROOT, "packages/mantle/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const direct = Object.keys(manifest.dependencies ?? {}).sort();
  const expected = ["@aotter/mantle-runtime", "@aotter/mantle-spec"];
  if (JSON.stringify(direct) !== JSON.stringify(expected)) {
    fail(path, `umbrella direct dependencies must be Core-only: ${expected.join(", ")}`);
  }
  for (const name of [
    "@aotter/mantle-admin",
    "@aotter/mantle-admin-ui",
    "@aotter/mantle-bun",
    "@aotter/mantle-cloudflare",
    "@aotter/mantle-vercel",
    "@aotter/mantle-web",
  ]) {
    if (!manifest.peerDependenciesMeta?.[name]?.optional) {
      fail(path, `${name} must be an optional umbrella peer`);
    }
  }
}

function checkLegacyStackDeleted() {
  const roots = [
    "packages/mantle-runtime/src",
    "packages/mantle/src",
    "packages/mantle-admin/src",
    "packages/mantle-web/src",
    "packages/adapters/bun/src",
    "packages/adapters/vercel/src",
    "packages/adapters/cloudflare/src",
  ];
  const forbidden = [
    "createCmsRuntime",
    "CmsRuntime",
    "bindMantleSite",
    "MantleSite",
    "mountServerEndpoints",
    "createCmsRef",
    "CmsConfig",
  ];
  for (const root of roots) {
    for (const file of listFiles(join(ROOT, root), (path) => path.endsWith(".ts"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const token of forbidden) {
        if (new RegExp(`\\b${token}\\b`).test(source)) {
          fail(file, `legacy runtime stack token remains: '${token}'`);
        }
      }
    }
  }
  const parser = readFileSync(
    join(ROOT, "packages/mantle-spec/src/domain/service/ManifestParser.ts"),
    "utf8",
  );
  if (/export function parseManifests(?:OrThrow)?\b/.test(parser)) {
    fail(join(ROOT, "packages/mantle-spec/src/domain/service/ManifestParser.ts"),
      "raw parser compatibility export remains");
  }
  if (existsSync(join(ROOT, "packages/mantle-runtime/src/runtime.ts"))) {
    fail(join(ROOT, "packages/mantle-runtime/src/runtime.ts"), "legacy facade file remains");
  }
}

function checkBunPackageBoundary() {
  const runtimePath = join(ROOT, "packages/mantle-runtime/package.json");
  const bunPath = join(ROOT, "packages/adapters/bun/package.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  const bun = JSON.parse(readFileSync(bunPath, "utf8"));
  const runtimeDeps = { ...runtime.dependencies, ...runtime.optionalDependencies };
  if (runtimeDeps["@aotter/mantle-bun"] || runtimeDeps["@types/bun"]) {
    fail(runtimePath, "runtime must stay installable without Bun");
  }
  if (!bun.dependencies?.["@aotter/mantle-runtime"] ||
      !bun.dependencies?.["@aotter/mantle-spec"]) {
    fail(bunPath, "Bun must compose downstream from Runtime and Spec");
  }
  for (const dependency of [
    "@aotter/mantle-admin",
    "@aotter/mantle-admin-ui",
    "@aotter/mantle-cloudflare",
    "@aotter/mantle-vercel",
    "@aotter/mantle-web",
    "hono",
  ]) {
    if (bun.dependencies?.[dependency]) {
      fail(bunPath, `Bun must not depend on optional or platform package '${dependency}'`);
    }
  }
  for (const dependency of Object.keys(bun.dependencies ?? {})) {
    if (dependency.startsWith("@cloudflare/") || dependency.startsWith("@vercel/")) {
      fail(bunPath, `Bun must not depend on platform package '${dependency}'`);
    }
  }

  const runtimeSource = listFiles(
    join(ROOT, "packages/mantle-runtime/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  if (runtimeSource.includes("bun:sqlite") || /\bBun\./.test(runtimeSource)) {
    fail(runtimePath, "runtime source cannot import or call Bun primitives");
  }

  const bunSource = listFiles(
    join(ROOT, "packages/adapters/bun/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  if (/from\s+["'][^"']*mantle-(?:admin|cloudflare|vercel|web)[^"']*["']/.test(bunSource) ||
      /\b(?:D1Database|ExecutionContext)\b/.test(bunSource)) {
    fail(bunPath, "Bun cannot import optional products or another platform adapter");
  }
  if (/\bBun\.serve\s*\(|\.close\s*\(/.test(bunSource)) {
    fail(bunPath, "Bun adapter must not own the host server or database lifecycle");
  }
}

function checkVercelPackageBoundary() {
  const runtimePath = join(ROOT, "packages/mantle-runtime/package.json");
  const vercelPath = join(ROOT, "packages/adapters/vercel/package.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
  const runtimeDeps = { ...runtime.dependencies, ...runtime.optionalDependencies };
  if (runtimeDeps["@aotter/mantle-vercel"] || runtimeDeps["@vercel/functions"]) {
    fail(runtimePath, "runtime must stay installable without Vercel");
  }
  if (!vercel.dependencies?.["@aotter/mantle-runtime"] ||
      !vercel.dependencies?.["@vercel/functions"]) {
    fail(vercelPath, "Vercel must compose downstream from Runtime and its lifecycle API");
  }
  for (const dependency of [
    "@aotter/mantle-admin",
    "@aotter/mantle-admin-ui",
    "@aotter/mantle-bun",
    "@aotter/mantle-cloudflare",
    "@aotter/mantle-web",
    "hono",
  ]) {
    if (vercel.dependencies?.[dependency]) {
      fail(vercelPath, `Vercel must not depend on optional or platform package '${dependency}'`);
    }
  }

  const runtimeSource = listFiles(
    join(ROOT, "packages/mantle-runtime/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  if (runtimeSource.includes("@vercel/") || /\bVERCEL_/.test(runtimeSource)) {
    fail(runtimePath, "runtime source cannot import or assume Vercel primitives");
  }

  const vercelSource = listFiles(
    join(ROOT, "packages/adapters/vercel/src"),
    (path) => path.endsWith(".ts"),
  ).map((path) => stripComments(readFileSync(path, "utf8"))).join("\n");
  if (/from\s+["'][^"']*mantle-(?:admin|bun|cloudflare|web)[^"']*["']/.test(vercelSource) ||
      /\b(?:D1Database|ExecutionContext|Bun\.serve)\b/.test(vercelSource)) {
    fail(vercelPath, "Vercel cannot import optional products or another platform adapter");
  }
  if (/from\s+["']node:fs["']|["']\/tmp(?:\/|["'])|\bcreateClient\s*\(|\.close\s*\(/.test(vercelSource)) {
    fail(vercelPath, "Vercel adapter cannot own local durable state or client lifecycle");
  }
  const main = stripComments(readFileSync(
    join(ROOT, "packages/adapters/vercel/src/index.ts"),
    "utf8",
  ));
  if (main.includes("libsql")) {
    fail(vercelPath, "the default Vercel entry must not select optional libSQL");
  }

  const fixtureFiles = listFiles(
    join(ROOT, "fixtures/vercel-node/api"),
    (path) => path.endsWith(".ts"),
  );
  for (const file of fixtureFiles) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (/["']file:|["']\/tmp(?:\/|["'])/.test(source)) {
      fail(file, "Vercel live fixture cannot select function-local canonical storage");
    }
  }
}

function checkViewExecutionBoundary() {
  const file = join(
    ROOT,
    "packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts",
  );
  const source = stripComments(readFileSync(file, "utf8"));
  for (const token of ["DatabaseDriver", "ViewSqlCompiler", "compileView", "lowerView"]) {
    if (source.includes(token)) {
      fail(file, `View invocation must depend on ViewQueryExecutor, not '${token}'`);
    }
  }
}

function checkMantleRuntimeBoundary() {
  const file = join(ROOT, "packages/mantle-runtime/src/MantleRuntime.ts");
  const source = stripComments(readFileSync(file, "utf8"));
  for (const token of ["DatabaseDriver", "AssetServer", "TemplateRegistry", "bootInit"]) {
    if (source.includes(token)) {
      fail(file, `MantleRuntime must bind prepared Core ports, not '${token}'`);
    }
  }
  if (/\b(?:manifests?|sources?)\s*:\s*readonly\b/.test(source)) {
    fail(file, "MantleRuntime cannot accept raw manifests or authored sources");
  }
  if (/from\s+["'][^"']*(?:mantle-web|mantle-admin|mantle-bun|mantle-cloudflare|mantle-vercel)[^"']*["']/.test(source)) {
    fail(file, "MantleRuntime cannot import Web, Admin, or platform packages");
  }
}

function checkCodegenBoundary() {
  const file = join(ROOT, "packages/mantle/src/emitMantleModule.ts");
  const source = stripComments(readFileSync(file, "utf8"));
  for (const token of ["node:", "mantle-admin", "mantle-cloudflare", "mantle-web"]) {
    if (source.includes(token)) {
      fail(file, `the pure codegen emitter cannot reference '${token}'`);
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

function checkRepositoryGuidance() {
  const agentsPath = join(ROOT, "AGENTS.md");
  const claudePath = join(ROOT, "CLAUDE.md");
  const contributingPath = join(ROOT, "CONTRIBUTING.md");
  const releaseSkillPath = join(ROOT, ".agent/skills/mantle-release/SKILL.md");
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
  if (!releaseSkill.includes("All nine npmjs artifacts")) {
    fail(releaseSkillPath, "canonical release skill must match the nine-package topology");
  }
  if (!claudeRelease.includes("../../../.agent/skills/mantle-release/SKILL.md") ||
      claudeRelease.split("\n").length > 8 ||
      /^## (?:Contract|Prepare|Run|Recovery)/m.test(claudeRelease)) {
    fail(claudeReleasePath, "Claude release entry must only point to the canonical skill");
  }

  for (const stalePath of [
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
      !path.endsWith("migration-0.1.2.md") &&
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

checkDatabasePropertyDetector();
checkRuntimeCloudflareFree();
checkPackageDirection();
checkEntryReadOwnership();
checkWebPackageBoundary();
checkAdminPackageBoundary();
checkUmbrellaPackageBoundary();
checkBunPackageBoundary();
checkVercelPackageBoundary();
checkViewExecutionBoundary();
checkMantleRuntimeBoundary();
checkCodegenBoundary();
checkNodeTestingBoundary();
checkSkillDocsVersioned();
checkRepositoryGuidance();
checkLegacyStackDeleted();

if (failures.length > 0) {
  console.error("Boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Boundary check passed.");
