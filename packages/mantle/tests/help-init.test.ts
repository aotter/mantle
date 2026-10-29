import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { help, topics } from "../src/infrastructure/help.js";
import { unmountedWarnings } from "../src/infrastructure/mounts.js";
import { generateOrThrow, loadFixtureSources } from "./apps/link.js";

const cli = join(resolve(import.meta.dir, ".."), "dist/infrastructure/cli.js");
const run = (cwd: string, ...args: string[]) => spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
const COMMANDS = ["help", "init", "generate", "bundle", "describe"];

test("every command and help topic that help names exists", () => {
  const all = topics();
  for (const topic of all.filter(t => !t.name.startsWith("releases/"))) {
    // Release notes are history and may name retired commands; "has no `mantle x`" names an absent one on purpose.
    const text = help(topic.name).split("\n").filter(line => !/\bno `mantle /.test(line)).join("\n");
    for (const [, command] of text.matchAll(/`mantle ([a-z][\w-]*)/g)) expect(COMMANDS, `${topic.name} names mantle ${command}`).toContain(command!);
    for (const [, name] of text.matchAll(/mantle help ([\w./-]*[\w/-])/g)) if (name !== "topics") expect(() => help(name), `${topic.name} names mantle help ${name}`).not.toThrow();
  }
});

test("help with no topic starts at the agent entry and lists the topics", () => {
  const output = run(tmpdir(), "help");
  expect(output.status).toBe(0);
  expect(output.stdout).toStartWith("# Build with an agent");
  expect(output.stdout).toContain("mantle help guides/agent-workflow-acceptance");
  expect(run(tmpdir()).stdout).toBe(output.stdout);
  // -h prints usage and runs nothing; options without positionals are a usage error, not help.
  const dir = mkdtempSync(join(tmpdir(), "mantle-help-"));
  try {
    for (const args of [["init", "-h"], ["generate", "--help"], ["-h"]]) {
      const shown = run(dir, ...args);
      expect(shown.status).toBe(0);
      expect(shown.stdout).toContain("Usage: mantle help");
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(run(dir, "--check").status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const unknown = run(tmpdir(), "help", "authorization");
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain("mantle help concepts/authorization");
});

test("init writes the shell once, pins the SDK version and never overwrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-init-"));
  try {
    const dry = run(dir, "init", "app", "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Would write");
    expect(spawnSync("ls", [join(dir, "app")]).status).not.toBe(0);
    const first = run(dir, "init", "app");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("src/auth.ts:");
    expect(await readFile(join(dir, "app/.gitignore"), "utf8")).toContain(".dev.vars");
    const { version } = JSON.parse(await readFile(join(resolve(import.meta.dir, ".."), "package.json"), "utf8"));
    const pkg = JSON.parse(await readFile(join(dir, "app/package.json"), "utf8"));
    expect(pkg.dependencies["@aotter/mantle"]).toBe(version);
    await writeFile(join(dir, "app/src/routes.ts"), "// mine\n");
    const again = run(dir, "init", "app");
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("src/routes.ts");
    expect(await readFile(join(dir, "app/src/routes.ts"), "utf8")).toBe("// mine\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("generation warns for each selected surface the entry never imports, statically or dynamically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mantle-mounts-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const files = { "rest.ts": "serve([{ method: \"GET\", pattern: new RegExp(\"^/api/x$\") }])", "mcp.ts": "", "admin-bindings.ts": "" };
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), `export const x = 1; // ${text}\n`);
    await writeFile(join(dir, "entry.ts"), `import "./rest.js";\nexport const later = () => import("./mcp.js");\n`);
    const warnings = await unmountedWarnings("entry.ts", ".", files);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("admin-bindings.ts");
    expect(warnings[0]).toContain("mantle help native-admin");
    expect(await unmountedWarnings("missing.ts", ".", files)).toEqual([]);
    expect(await unmountedWarnings("entry.ts", ".", { "rest.ts": "no routes" })).toEqual([]);
  } finally { process.chdir(cwd); await rm(dir, { recursive: true, force: true }); }
});

test("real generated output selects the surfaces the mount check looks for", async () => {
  const files = await generateOrThrow("bun-sqlite", await loadFixtureSources("purchase.yaml"));
  const dir = await mkdtemp(join(tmpdir(), "mantle-mounts-real-")), cwd = process.cwd();
  try {
    process.chdir(dir);
    await writeFile(join(dir, "entry.ts"), "export default {};\n");
    // Pins the REST marker to the generator: a reformat of rest.ts that hides its routes fails here.
    expect((await unmountedWarnings("entry.ts", "generated", files)).join("\n")).toContain("REST routes");
  } finally { process.chdir(cwd); await rm(dir, { recursive: true, force: true }); }
});
