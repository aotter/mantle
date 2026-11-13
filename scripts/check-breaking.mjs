#!/usr/bin/env node
/**
 * A breaking change is a checked state, not only a label (CONTRIBUTING.md, "Breaking changes"). Compared with its base,
 * a change is breaking when a published package's exports-map key disappears, moves under `./internal/`, starts
 * resolving to a removed-subpath stub or loses a condition, when a `bin` name disappears, when a published peer range
 * changes or a peer becomes required, or when a commit subject carries `!`. Each must be declared in the PR body's
 * "Migration" section; in CI the PR also needs `breaking-change`. A stub past its `removeAfter` always fails.
 *
 *   node scripts/check-breaking.mjs                     base origin/develop; body from --body <file> or MANTLE_PR_BODY
 *   node scripts/check-breaking.mjs --event <path>      CI on the PR merge commit: HEAD^1 is the base, HEAD^2 the PR
 *                                                       head; body and labels from the pull_request event payload
 *   node scripts/check-breaking.mjs --base <ref> --body <file>
 *   node scripts/check-breaking.mjs --self-test
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "breaking-change";
const STUBS = "./dist/removed/";
const REGISTRY = "removed-subpaths.json";
const RULES = 'CONTRIBUTING.md, "Breaking changes"';

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args).trim();
  } catch {
    return undefined;
  }
};

/** `catalog:` and `catalogs:` of pnpm-workspace.yaml: flat `name: range` lines, indented two or four spaces. */
export function catalogs(text) {
  const result = {};
  let top, current;
  for (const line of text.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = line.match(/^( *)(['"]?)([^'":]+)\2:\s*(?:['"]?([^'"#]*?)['"]?)?\s*(?:#.*)?$/);
    if (!match) continue;
    const [, indent, , key, value] = match;
    if (indent === "") {
      top = key;
      current = top === "catalog" ? (result.default ??= {}) : undefined;
    } else if (top === "catalogs" && indent.length === 2 && !value) current = result[key] ??= {};
    else if (current && value) current[key] = value;
  }
  return result;
}

const resolveRange = (name, range, catalog) =>
  range.startsWith("catalog:") ? (catalog[range.slice(8) || "default"]?.[name] ?? range) : range;

/** `X.Y.Z[-alpha|beta|rc.N]` as a sortable tuple; a stable follows its prereleases. */
export function versionKey(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(version ?? "");
  if (!match) return undefined;
  const [, major, minor, patch, channel, number] = match;
  return [major, minor, patch, channel ? ["alpha", "beta", "rc"].indexOf(channel) : 3, number ?? 0].map(Number);
}
export function isAfter(left, right) {
  const [a, b] = [versionKey(left), versionKey(right)];
  if (!a || !b) return false;
  const index = a.findIndex((value, at) => value !== b[at]);
  return index >= 0 && a[index] > b[index];
}

/**
 * Published packages at a revision (`undefined` = the working tree): version, exports map, `bin` names, resolved peers
 * and the removed-subpath stub registry (`removed-subpaths.json` beside package.json).
 */
export function snapshot(cwd, ref) {
  const read = path =>
    ref === undefined
      ? existsSync(join(cwd, path))
        ? readFileSync(join(cwd, path), "utf8")
        : undefined
      : tryGit(cwd, "show", `${ref}:${path}`);
  const directories =
    ref === undefined
      ? existsSync(join(cwd, "packages"))
        ? readdirSync(join(cwd, "packages"))
        : []
      : (tryGit(cwd, "ls-tree", "--name-only", `${ref}:packages`) ?? "").split("\n").filter(Boolean);
  const catalog = catalogs(read("pnpm-workspace.yaml") ?? "");
  const packages = {};
  for (const directory of directories) {
    const text = read(`packages/${directory}/package.json`);
    if (!text) continue;
    const pkg = JSON.parse(text);
    if (pkg.private || !pkg.name) continue;
    const exports =
      typeof pkg.exports === "string" || Object.keys(pkg.exports ?? {}).some(key => !key.startsWith("."))
        ? { ".": pkg.exports }
        : (pkg.exports ?? {});
    const bin = typeof pkg.bin === "string" ? { [pkg.name.split("/").pop()]: pkg.bin } : (pkg.bin ?? {});
    const peers = {};
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {}))
      peers[name] = {
        range: resolveRange(name, range, catalog),
        optional: !!pkg.peerDependenciesMeta?.[name]?.optional,
      };
    const removed = JSON.parse(read(`packages/${directory}/${REGISTRY}`) ?? "{}");
    packages[pkg.name] = { version: pkg.version, exports, bin, peers, removed };
  }
  return { packages };
}

/** The target strings of an exports entry, at any condition depth. */
const leaves = target =>
  typeof target === "string"
    ? [target]
    : target && typeof target === "object"
      ? Object.values(target).flatMap(leaves)
      : [];
const isStub = target => leaves(target).length > 0 && leaves(target).every(leaf => leaf.startsWith(STUBS));
/** Condition paths of an exports entry: `""` for a plain string, `import`, `node.import` … for a conditional object. */
const conditions = target =>
  typeof target === "string"
    ? [""]
    : target && typeof target === "object"
      ? Object.entries(target).flatMap(([key, value]) => conditions(value).map(path => (path ? `${key}.${path}` : key)))
      : [];
const specifier = (name, key) => (key === "." ? name : `${name}${key.slice(1)}`);

/** What changed between two snapshots that breaks an application, plus the `!` commit subjects. */
export function analyze(base, head, subjects) {
  const items = [];
  const shared = Object.keys(base.packages).filter(name => head.packages[name]);
  // The release version PR moves every published package to a new version, and a lockstep peer (Admin on Core) with it.
  const release =
    shared.length > 0 && shared.every(name => base.packages[name].version !== head.packages[name].version);
  for (const [name, before] of Object.entries(base.packages)) {
    const after = head.packages[name] ?? { version: undefined, exports: {}, bin: {}, peers: {} };
    for (const [key, target] of Object.entries(before.exports)) {
      if (key.startsWith("./internal/")) continue; // plumbing carries no promise
      const id = specifier(name, key);
      if (isStub(target)) {
        // A stub was declared when it replaced its subpath; deleting it is breaking only before its removeAfter.
        const due = before.removed?.[key]?.removeAfter;
        if (!(key in after.exports) && !isAfter(after.version, due))
          items.push({
            kind: "unstubbed",
            needle: id,
            text: `${id} stub deleted before its removeAfter (${due ?? "unregistered"})`,
          });
        continue;
      }
      if (key in after.exports) {
        const next = after.exports[key];
        if (isStub(next)) items.push({ kind: "stubbed", needle: id, text: `${id} now throws (removed with stub)` });
        else if (typeof next !== "string") {
          const kept = conditions(next);
          const lost = conditions(target).filter(path => !kept.includes(path) && !(path === "" && "default" in next));
          if (lost.length)
            items.push({
              kind: "narrowed",
              needle: id,
              text: `${id} no longer resolves ${lost.map(path => path || "every condition").join(", ")}`,
            });
        }
      } else if (`./internal/${key.slice(2)}` in after.exports)
        items.push({
          kind: "moved",
          needle: id,
          text: `${id} moved under ${specifier(name, `./internal/${key.slice(2)}`)}`,
        });
      else items.push({ kind: "removed", needle: id, text: `${id} removed from the exports map` });
    }
    for (const command of Object.keys(before.bin ?? {}))
      if (!(command in (after.bin ?? {})))
        items.push({ kind: "bin", needle: command, text: `${name} bin "${command}" removed` });
    for (const [dependency, peer] of Object.entries(after.peers)) {
      const old = before.peers[dependency];
      if (!old ? peer.optional : old.range === peer.range && (peer.optional || !old.optional)) continue;
      const lockstep =
        release &&
        old?.range === base.packages[dependency]?.version &&
        peer.range === head.packages[dependency]?.version &&
        peer.optional === old.optional;
      if (lockstep) continue;
      const change = !old
        ? `added as required (${peer.range})`
        : old.range === peer.range
          ? "optional → required"
          : `${old.range} → ${peer.range}${old.optional && !peer.optional ? ", now required" : ""}`;
      items.push({ kind: "peer", needle: dependency, text: `${name} peer ${dependency} ${change}` });
    }
  }
  for (const subject of subjects)
    if (/^[a-z]+(?:\([^)]*\))?!:/i.test(subject)) items.push({ kind: "bang", text: `commit "${subject}"` });
  return items;
}

/** Stubs whose package version is past their registered `removeAfter`: the version PR deletes them. */
export function overdue(head) {
  const failures = [];
  for (const [name, pkg] of Object.entries(head.packages))
    for (const [key, entry] of Object.entries(pkg.removed ?? {}))
      if (
        isStub(pkg.exports[key]) &&
        (versionKey(entry.removeAfter)?.[3] !== 3 || isAfter(pkg.version, entry.removeAfter))
      )
        failures.push(
          `${specifier(name, key)} is a stub past its removeAfter ${entry.removeAfter} (version ${pkg.version}; removeAfter must be a stable version): delete it (CONTRIBUTING.md, "Removed public subpaths")`,
        );
  return failures;
}

/** Without backtracking: a body is untrusted input, and a regex over long whitespace runs is not linear. */
function withoutComments(text) {
  let result = "",
    from = 0;
  for (let open = text.indexOf("<!--"); open >= 0; open = text.indexOf("<!--", from)) {
    result += text.slice(from, open);
    const close = text.indexOf("-->", open + 4);
    if (close < 0) return result;
    from = close + 3;
  }
  return result + text.slice(from);
}

/** Entries of the body's "Migration" section: lines with `before → after`, HTML comments removed. */
export function migration(body) {
  const lines = withoutComments(body ?? "").split("\n");
  const heading = line => line.startsWith("#") && /^#{1,6}[ \t]/.test(line);
  const start = lines.findIndex(line => heading(line) && /^#{1,6}[ \t]+Migration\b/i.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && heading(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).flatMap(line => {
    const arrows = [line.indexOf("→"), line.indexOf("->")].filter(index => index >= 0);
    if (!arrows.length) return [];
    const at = Math.min(...arrows);
    const before = line
      .slice(0, at)
      .trim()
      .replace(/^(?:[-*+]|\d+\.)(?=\s)/, "")
      .trim();
    const after = line.slice(at + (line.startsWith("→", at) ? 1 : 2)).trim();
    if (!before || !after) return [];
    const none = /\bno replacement\b/i.test(after);
    return [
      {
        line: line.trim(),
        before,
        none,
        named: !none && /`[^`]+`/.test(after),
        stub: /\bremoved with stub\b/i.test(after),
      },
    ];
  });
}

/** `needle` as a whole name: `react` is not mentioned by `preact` or `react-dom`. */
export const mentions = (text, needle) =>
  new RegExp(`(?<![\\w@/.-])${needle.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w/-])`).test(text);

/** Failures for the detected items against the PR body and labels (`labels` undefined: not checked). */
export function verdict(items, body, labels, head) {
  const failures = [];
  const declared = labels?.includes(LABEL);
  if (!items.length && !declared) return failures;
  const entries = migration(body);
  const complete = (entries ?? []).filter(entry => entry.named || entry.none);
  if (!entries) failures.push('the PR body has no "## Migration" section');
  for (const entry of entries ?? [])
    if (!entry.named && !entry.none)
      failures.push(`Migration entry "${entry.line}" names neither a replacement (in backticks) nor "no replacement"`);
  for (const item of items.filter(item => item.needle)) {
    const entry = complete.find(entry => mentions(entry.before, item.needle));
    if (!entry)
      failures.push(
        `${item.text}: no Migration line "\`${item.needle}\` → …" naming a replacement or "no replacement"`,
      );
    else if (item.kind === "stubbed" && !entry.named)
      failures.push(`${item.text}: a stub names its replacement, so its Migration line must name it too`);
    else if ((item.kind === "removed" || item.kind === "moved") && entry.named)
      failures.push(
        `${item.text}: the Migration line names a replacement, so the subpath keeps a throwing stub for one further release (CONTRIBUTING.md, "Removed public subpaths"), or write "no replacement"`,
      );
  }
  for (const entry of complete.filter(entry => entry.stub)) {
    const stubbed = Object.entries(head?.packages ?? {}).some(([name, pkg]) =>
      Object.entries(pkg.exports).some(
        ([key, target]) => isStub(target) && mentions(entry.before, specifier(name, key)),
      ),
    );
    if (!stubbed)
      failures.push(
        `Migration entry "${entry.line}" says "removed with stub" but names no subpath that resolves to a stub`,
      );
  }
  // A `!` commit says something broke but not what: count it, since a line cannot be matched to a commit.
  const bangs = items.filter(item => item.kind === "bang");
  if (complete.length < Math.max(bangs.length, declared ? 1 : 0))
    failures.push(
      `${bangs.length ? bangs.map(item => item.text).join(", ") : `the ${LABEL} label`}: ${Math.max(bangs.length, 1)} complete Migration line(s) needed, found ${complete.length}`,
    );
  if (labels && items.length && !declared)
    failures.push(`the PR makes a breaking change but lacks the "${LABEL}" label`);
  return failures;
}

function report(items, failures) {
  if (items.length)
    console.log(
      `check-breaking: breaking changes against the base:\n${items.map(item => `  - ${item.text}`).join("\n")}`,
    );
  if (!failures.length) return 0;
  console.error(
    `check-breaking: FAILED (${RULES})\n${failures.map(failure => `  - ${failure}`).join("\n")}\n` +
      'Declare each in the PR body under "## Migration", one line per item: `before` → `after` naming the replacement, or "no replacement".',
  );
  return 1;
}

function check(cwd, args) {
  const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const eventPath = option("--event");
  const event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : undefined;
  if (event && !event.pull_request) {
    console.error("check-breaking: FAILED: the event payload has no pull_request");
    return 1;
  }
  const head = snapshot(cwd, undefined);
  const late = overdue(head);
  let base, range, baseName;
  if (event) {
    // The payload's base.sha is not refreshed when the base branch moves; the merge commit's own parents are current,
    // and HEAD^1..HEAD^2 leaves out base-branch commits a branch merged in.
    if (tryGit(cwd, "rev-parse", "--verify", "--quiet", "HEAD^2") === undefined) {
      console.error(
        "check-breaking: FAILED: HEAD is not the PR merge commit (check out refs/pull/<n>/merge with fetch-depth: 0)",
      );
      return 1;
    }
    [base, range, baseName] = [git(cwd, "rev-parse", "HEAD^1").trim(), "HEAD^1..HEAD^2", "the PR's base"];
  } else {
    baseName = option("--base") ?? "origin/develop";
    base = tryGit(cwd, "merge-base", baseName, "HEAD");
    range = `${base}..HEAD`;
  }
  if (!base) {
    report([], late);
    console.log(`check-breaking: NOTICE: skipped, base ${baseName} not found; fetch it or pass --base <ref>`);
    return late.length ? 1 : 0;
  }
  const subjects = git(cwd, "log", "--format=%s", range).split("\n").filter(Boolean);
  const items = analyze(snapshot(cwd, base), head, subjects);
  const bodyPath = option("--body") ?? process.env.MANTLE_PR_BODY;
  if (!event && !bodyPath) {
    const status = report(items, late);
    console.log(
      items.length
        ? `check-breaking: NOTICE: PR body not checked; ${items.length} item(s) above must be declared. Pass --body <file> (or MANTLE_PR_BODY) to check it.`
        : `check-breaking: no breaking change against ${baseName}; PR body not checked (pass --body <file>).`,
    );
    return status;
  }
  const body = event ? (event.pull_request.body ?? "") : readFileSync(bodyPath, "utf8");
  const labels =
    event && Array.isArray(event.pull_request.labels) ? event.pull_request.labels.map(label => label.name) : undefined;
  if (event && !labels)
    console.log(`check-breaking: NOTICE: the event payload lists no labels; "${LABEL}" not checked.`);
  const status = report(items, [...late, ...verdict(items, body, labels, head)]);
  if (!status)
    console.log(`check-breaking: ${items.length ? "every breaking change is declared" : "no breaking change"}.`);
  return status;
}

function selfTest() {
  const pkg = (exports, peers = {}, version = "1.0.0", extra = {}) => ({
    version,
    exports,
    bin: {},
    peers,
    removed: {},
    ...extra,
  });
  const peer = (range, optional = false) => ({ range, optional });
  const core = pkg(
    {
      ".": "./dist/index.js",
      "./old": "./dist/old.js",
      "./plumbing": "./dist/p.js",
      "./internal/x": "./dist/x.js",
      "./cond": { types: "./dist/c.d.ts", import: "./dist/c.js" },
      "./gone-stub": "./dist/removed/gone.js",
    },
    { react: peer("^19.0.0"), auth: peer("1.0.0", true) },
    "1.0.0",
    { bin: { core: "./cli.js" }, removed: { "./gone-stub": { removeAfter: "1.1.0" } } },
  );
  const base = {
    packages: {
      "@scope/core": core,
      "@scope/admin": pkg({ "./app": "./dist/app.js" }, { "@scope/core": peer("1.0.0") }),
    },
  };
  const change = (edit, subjects = []) => {
    const head = structuredClone(base);
    edit(head.packages);
    return { head, items: analyze(base, head, subjects) };
  };
  const kinds = ({ items }) => items.map(item => `${item.kind} ${item.needle ?? item.text}`);

  // False positives: an added export, an internal → internal move, a retargeted file with the same conditions, an added
  // optional peer, and the release version PR (every version moves, the lockstep peer with it).
  const quiet = change(
    packages => {
      packages["@scope/core"].exports["./new"] = "./dist/new.js";
      delete packages["@scope/core"].exports["./internal/x"];
      packages["@scope/core"].exports["./internal/y"] = "./dist/x.js";
      packages["@scope/core"].exports["./old"] = "./dist/moved/old.js";
      packages["@scope/core"].exports["./cond"] = {
        types: "./dist/c2.d.ts",
        import: "./dist/c2.js",
        require: "./c.cjs",
      };
      packages["@scope/core"].version = packages["@scope/admin"].version = "1.0.1";
      packages["@scope/admin"].peers["@scope/core"] = peer("1.0.1");
      packages["@scope/admin"].peers.extra = peer("^1", true);
    },
    ["chore(release): prepare 1.0.1", "feat: a non-breaking change"],
  );
  assert.deepEqual(quiet.items, []);
  assert.deepEqual(verdict(quiet.items, "", [], quiet.head), []);
  // Outside the release shape, the same lockstep peer move is a peer change.
  assert.deepEqual(kinds(change(packages => (packages["@scope/admin"].peers["@scope/core"] = peer("1.0.1")))), [
    "peer @scope/core",
  ]);

  // Each breaking kind is detected.
  const removed = change(packages => delete packages["@scope/core"].exports["./old"]);
  assert.deepEqual(kinds(removed), ["removed @scope/core/old"]);
  const moved = change(packages => {
    delete packages["@scope/core"].exports["./plumbing"];
    packages["@scope/core"].exports["./internal/plumbing"] = "./dist/p.js";
  });
  assert.deepEqual(kinds(moved), ["moved @scope/core/plumbing"]);
  const stubbed = change(packages => (packages["@scope/core"].exports["./old"] = "./dist/removed/old.js"));
  assert.deepEqual(kinds(stubbed), ["stubbed @scope/core/old"]);
  // Only ./dist/removed/ is a stub.
  assert.deepEqual(
    kinds(change(packages => (packages["@scope/core"].exports["./old"] = "./dist/kernel/removed/old.js"))),
    [],
  );
  const narrowed = change(packages => {
    packages["@scope/core"].exports["./cond"] = { import: "./dist/c.js" };
    packages["@scope/core"].exports["."] = { types: "./dist/index.d.ts", import: "./dist/index.js" };
  });
  assert.deepEqual(kinds(narrowed), ["narrowed @scope/core", "narrowed @scope/core/cond"]);
  assert.match(narrowed.items[1].text, /no longer resolves types$/);
  const bin = change(packages => (packages["@scope/core"].bin = { "core-cli": "./cli.js" }));
  assert.deepEqual(kinds(bin), ["bin core"]);
  const bang = change(() => {}, ["feat(api)!: rename the option", "fix: unrelated"]);
  assert.deepEqual(kinds(bang), ['bang commit "feat(api)!: rename the option"']);
  const peerChanged = change(packages => (packages["@scope/core"].peers.react = peer("^19.3.0")));
  assert.deepEqual(kinds(peerChanged), ["peer react"]);
  const required = change(packages => (packages["@scope/core"].peers.auth = peer("1.0.0")));
  assert.deepEqual(
    required.items.map(item => item.text),
    ["@scope/core peer auth optional → required"],
  );
  // Deleting a stub is breaking only before its removeAfter.
  const unstub = version =>
    change(packages => {
      delete packages["@scope/core"].exports["./gone-stub"];
      packages["@scope/core"].version = version;
    });
  assert.deepEqual(kinds(unstub("1.1.0")), ["unstubbed @scope/core/gone-stub"]);
  assert.deepEqual(kinds(unstub("1.1.1-alpha.1")), []);
  // A stub past removeAfter fails in every mode.
  assert.deepEqual(overdue(base), []);
  assert.match(overdue(unstub("1.1.1-alpha.1").head).join(), /^$/);
  assert.match(
    overdue(change(packages => (packages["@scope/core"].version = "1.1.1-alpha.1")).head).join(),
    /@scope\/core\/gone-stub is a stub past its removeAfter 1\.1\.0/,
  );
  assert(isAfter("1.1.0", "1.1.0-rc.1") && !isAfter("1.1.0-rc.1", "1.1.0") && !isAfter("1.1.0", "1.1.0"));
  assert(isAfter("1.0.0-alpha.10", "1.0.0-alpha.9") && !isAfter("1.0.0", undefined));

  // Undeclared: each fails, naming the item; CI also wants the label.
  const fails = (result, body, labels = [LABEL]) => verdict(result.items, body, labels, result.head).join("\n");
  assert.match(fails(removed, "## Summary\n\n- x"), /no "## Migration" section[\s\S]*@scope\/core\/old removed/);
  assert.match(
    fails(moved, "## Migration\n\n- something → `else`"),
    /@scope\/core\/plumbing moved under @scope\/core\/internal\/plumbing: no Migration line/,
  );
  assert.match(
    fails(bang, "## Migration\n"),
    /feat\(api\)!: rename the option.*1 complete Migration line\(s\) needed, found 0/,
  );
  assert.match(
    fails(peerChanged, "## Migration\n- `react` `^19.0.0` → `^19.3.0`", []),
    /lacks the "breaking-change" label/,
  );
  assert.match(
    fails(peerChanged, "## Migration\n- `preact` `^19.0.0` → `^19.3.0`"),
    /peer react \^19\.0\.0 → \^19\.3\.0: no Migration line/,
  );
  assert.match(fails(removed, "## Migration\n- `@scope/core/old` → gone"), /names neither a replacement/);
  assert.match(fails(bin, "## Migration\n"), /bin "core" removed: no Migration line/);
  // A named replacement needs a stub; "removed with stub" must match a stub.
  assert.match(
    fails(removed, "## Migration\n- `@scope/core/old` → `thing` from `@scope/core`"),
    /keeps a throwing stub/,
  );
  assert.match(fails(stubbed, "## Migration\n- `@scope/core/old` → no replacement"), /a stub names its replacement/);
  assert.match(
    fails(removed, "## Migration\n- `@scope/core/old` → `x` (removed with stub)"),
    /says "removed with stub" but names no subpath/,
  );
  // The label alone also asks for a Migration line.
  assert.match(fails({ items: [], head: base }, "## Summary"), /no "## Migration" section/);

  // Properly declared: pass.
  const passes = (result, body) => assert.deepEqual(verdict(result.items, body, [LABEL], result.head), [], body);
  passes(removed, "## Migration\n\n- `@scope/core/old` → no replacement\n\n## Test plan");
  passes(
    moved,
    "## Migration\n<!-- `before` → `after` -->\n- `@scope/core/plumbing` → no replacement (generated code only)",
  );
  passes(stubbed, "## Migration\n- `@scope/core/old` → `thing` from `@scope/core` (removed with stub)");
  passes(bang, "### Migration\n1. `option: a` → `option: b`");
  passes(peerChanged, "## Migration\n- `react` `^19.0.0` → `^19.3.0`, no replacement needed");
  passes(bin, "## Migration\n- `core` → `core-cli`");
  passes(
    narrowed,
    "## Migration\n- `@scope/core` → no replacement\n- `@scope/core/cond` -> `import` only, no replacement",
  );
  assert.deepEqual(verdict(peerChanged.items, "## Migration\n- `react` `^19.0.0` → `^19.3.0`", undefined, base), []);

  // The body is untrusted: parsing stays linear on long whitespace runs and unclosed comments.
  const started = performance.now();
  const spaces = " ".repeat(65536);
  assert.equal(migration(`## Migration\n-${spaces}x${spaces}→${spaces}\n<!--${"<!--".repeat(16384)}`).length, 0);
  assert.equal(migration(`## Migration\n- \`a\`${spaces}→${spaces}\`b\``)[0].named, true);
  assert(performance.now() - started < 1000, "Migration parsing must stay linear");

  // pnpm catalogs resolve `catalog:` peer ranges.
  const yaml =
    "packages:\n  - x\ncatalogs:\n  peer:\n    zod: ^4.5.0 # loose\ncatalog:\n  '@a/b': 1.2.3\n  c: \"^2\"\n";
  assert.deepEqual(catalogs(yaml), { peer: { zod: "^4.5.0" }, default: { "@a/b": "1.2.3", c: "^2" } });
  assert.equal(resolveRange("zod", "catalog:peer", catalogs(yaml)), "^4.5.0");
  assert.equal(resolveRange("c", "catalog:", catalogs(yaml)), "^2");
  assert.equal(resolveRange("c", "^3", catalogs(yaml)), "^3");

  const scratch = run => {
    const dir = mkdtempSync(join(tmpdir(), "check-breaking-"));
    try {
      git(dir, "init", "-q", "-b", "develop");
      mkdirSync(join(dir, "packages/core"), { recursive: true });
      const tools = {
        write: (path, text) => writeFileSync(join(dir, path), text),
        manifest: (exports, peer = "1.0.0") =>
          JSON.stringify({ peerDependencies: { dep: peer }, name: "@scope/core", version: "1.0.0", exports }, null, 2),
        git: (...args) => git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args).trim(),
        commit: message => {
          git(dir, "add", "-A");
          tools.git("commit", "-qm", message);
        },
        run: (...args) => {
          const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
            cwd: dir,
            encoding: "utf8",
          });
          return { status: result.status, output: result.stdout + result.stderr };
        },
      };
      run(tools);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // Locally: catalog peers, the working tree as head, private packages ignored, --body and the notice.
  scratch(({ write, manifest, commit, run }) => {
    write("pnpm-workspace.yaml", "catalog:\n  dep: 1.0.0\n");
    write("packages/core/package.json", manifest({ ".": "./a.js", "./gone": "./g.js" }, "catalog:"));
    commit("chore: base");
    write("README.md", "x");
    commit("refactor(core)!: drop gone");
    write("pnpm-workspace.yaml", "catalog:\n  dep: 1.1.0\n");
    write("packages/core/package.json", manifest({ ".": "./a.js" }, "catalog:"));
    const local = run("--base", "HEAD~1");
    assert.equal(local.status, 0, local.output);
    assert.match(
      local.output,
      /@scope\/core\/gone removed[\s\S]*dep 1\.0\.0 → 1\.1\.0[\s\S]*refactor\(core\)!: drop gone[\s\S]*NOTICE: PR body not checked; 3 item/,
    );
    write("body.md", "## Migration\n- `@scope/core/gone` → no replacement\n- `dep` `1.0.0` → `1.1.0`\n");
    assert.equal(run("--base", "HEAD~1", "--body", "body.md").status, 0);
    write("body.md", "## Migration\n- `dep` `1.0.0` → `1.1.0`\n");
    const failed = run("--base", "HEAD~1", "--body", "body.md");
    assert.equal(failed.status, 1);
    assert.match(failed.output, /FAILED[\s\S]*@scope\/core\/gone removed from the exports map: no Migration line/);
    assert.match(run("--base", "missing").output, /NOTICE: skipped, base missing not found/);
    write("event.json", JSON.stringify({ pull_request: { base: { sha: "0".repeat(40) }, body: null, labels: [] } }));
    assert.match(run("--event", "event.json").output, /HEAD is not the PR merge commit/);
  });

  // In CI: the payload's base.sha is stale and the branch merged develop in, yet only the PR's own change counts.
  scratch(({ write, manifest, git: g, commit, run }) => {
    write("packages/core/package.json", manifest({ ".": "./a.js", "./b": "./b.js", "./c": "./c.js" }));
    commit("chore: base");
    const stale = g("rev-parse", "HEAD");
    g("checkout", "-q", "-b", "feature");
    write("README.md", "docs");
    commit("docs: a docs-only change");
    g("checkout", "-q", "develop");
    write("packages/core/package.json", manifest({ ".": "./a.js", "./c": "./c.js" }));
    commit("refactor(core)!: drop b");
    g("checkout", "-q", "feature");
    g("merge", "-q", "--no-ff", "-m", "Merge branch 'develop' into feature", "develop");
    g("checkout", "-q", "develop");
    write("packages/core/package.json", manifest({ ".": "./a.js" }));
    commit("refactor(core)!: drop c");
    const pr = () => {
      g("checkout", "-q", "--detach", "develop");
      g("merge", "-q", "--no-ff", "-m", "Merge feature into develop", "feature");
    };
    pr();
    write("event.json", JSON.stringify({ pull_request: { base: { sha: stale }, body: "## Summary\n", labels: [] } }));
    const docsOnly = run("--event", "event.json");
    assert.equal(docsOnly.status, 0, docsOnly.output);
    assert.match(docsOnly.output, /check-breaking: no breaking change\./);
    // The PR's own breaking change is still found, and only it.
    g("checkout", "-q", "feature");
    write("packages/core/package.json", manifest({ ".": "./a.js", "./c": "./c.js" }, "2.0.0"));
    commit("chore: bump dep");
    pr();
    const own = run("--event", "event.json");
    assert.equal(own.status, 1);
    assert.match(
      own.output,
      /breaking changes against the base:\n {2}- @scope\/core peer dep 1\.0\.0 → 2\.0\.0\ncheck-breaking: FAILED/,
    );
  });
  console.log("check-breaking self-test passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") selfTest();
  else process.exit(check(process.cwd(), args));
}
