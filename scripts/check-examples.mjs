#!/usr/bin/env node
// Each shipped example runs on top of the app shell, from packed packages: generate, typecheck, then its smoke.
// --fresh runs only the fresh-copy checks (release gate): each packaged example, copied as a user would, installs
// without a lockfile and passes its `check` with npm and with pnpm 10.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const examples = join(root, "docs/examples");
const EXAMPLES = ["recipes", "club-events", "purchasing"];
// Examples with their own package.json. The others (and generated-web) are copied onto app-shell.
const PACKAGED = ["app-shell", "reference-service"];
const MANAGERS = ["npm", "pnpm@10.28.0"];
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const pins = expectedPins();
for (const example of PACKAGED) {
  const { dependencies } = JSON.parse(readFileSync(join(examples, example, "package.json"), "utf8"));
  for (const [name, pinned] of Object.entries(dependencies)) {
    if (name.startsWith("@aotter/mantle") && pinned !== version) throw new Error(`${example} pins ${name}@${pinned}; bump it to ${version}`);
  }
  // the app owns react and react-dom, and react-dom only runs beside the exact same react: one exact version for both
  const { react, "react-dom": reactDom } = dependencies;
  if (!/^\d+\.\d+\.\d+$/.test(react ?? "") || react !== reactDom)) throw new Error(`${example} must pin react and react-dom to one identical exact version (react ${react ?? "none"}, react-dom ${reactDom ?? "none"})`);
  for (const [name, expected] of Object.entries(pins)) {
    if (dependencies[name] !== expected) throw new Error(`${example} must pin ${name}@${expected} (has ${dependencies[name] ?? "none"})`);
  }
}
const args = process.argv.slice(2);
const fresh = args[0] === "--fresh";
const selected = fresh ? [] : args;
if (fresh && args.length !== 1) throw new Error("Usage: check-examples.mjs [--fresh | <example>...]");

if (!fresh) {
  for (const example of selected.length ? selected : EXAMPLES) {
    const source = join(examples, example);
    if (!existsSync(join(source, "manifests"))) throw new Error(`${example}: no manifests/`);
    const steps = ["pnpm generate", "pnpm types", "pnpm check", ...(existsSync(join(source, "smoke.mjs")) ? ["pnpm smoke"] : [])].join(" && ");
    console.log(`check-examples: ${example}`);
    consumer("app-shell", ["sh", "-c", `cp -R '${source}'/. . && ${steps}`]);
  }
}
if (!selected.length) {
  for (const pm of MANAGERS) {
    const run = pm === "npm" ? "npm run" : "pnpm";
    // app-shell has no manifests of its own, so its check runs with the first example on top.
    console.log(`check-examples: fresh app-shell + ${EXAMPLES[0]} with ${pm}`);
    consumer("app-shell", ["sh", "-c", `cp -R '${join(examples, EXAMPLES[0])}'/. . && ${run} generate && ${run} types && ${run} check`], pm);
    console.log(`check-examples: fresh reference-service with ${pm}`);
    consumer("reference-service", ["sh", "-c", `${run} check`], pm);
  }
}

function consumer(project, command, pm) {
  execFileSync(process.execPath, [join(root, "scripts/check-packed-consumer.mjs"), ...(pm ? ["--pm", pm] : []),
    "--project", join(examples, project), "--", ...command], { cwd: root, stdio: "inherit", timeout: 900_000 });
}

// Packaged examples pin exactly what the SDK peers require, plus the exact Better Auth packages those peers in
// turn require. Without the @better-auth/core and @better-auth/utils pins, a fresh install resolves newer ones
// (two Better Auth type trees: npm ERESOLVE, pnpm tsc errors). Source: SDK peers and the root pnpm catalog.
function expectedPins() {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const catalog = (name) => {
    const block = name ? workspace.match(new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n)+)`, "m"))?.[1] : workspace.match(/^catalog:\n((?:(?: {2}.*)?\n)+)/m)?.[1];
    if (!block) throw new Error(`pnpm-workspace.yaml: no catalog ${name ?? "(default)"}`);
    return Object.fromEntries([...block.matchAll(/^ +'?([^'\s#:][^':]*)'?: *(\S+)/gm)].map((match) => [match[1], match[2]]));
  };
  const { peerDependencies } = JSON.parse(readFileSync(join(root, "packages/mantle/package.json"), "utf8"));
  const pins = {};
  for (const [name, spec] of Object.entries(peerDependencies)) {
    pins[name] = spec.startsWith("catalog:") ? catalog(spec.slice("catalog:".length) || undefined)[name] : spec;
  }
  for (const name of ["@better-auth/core", "@better-auth/utils", "@better-auth/mcp", "@better-auth/cimd"]) pins[name] ??= catalog()[name];
  for (const [name, pinned] of Object.entries(pins)) {
    if (!/^\d+\.\d+\.\d+/.test(pinned ?? "")) throw new Error(`cannot resolve an exact SDK pin for ${name} (${pinned})`);
  }
  return pins;
}
