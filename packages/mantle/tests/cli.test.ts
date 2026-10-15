import { expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { parse } from "jsonc-parser";

const base = resolve(import.meta.dir, "..");
const cli = join(base, "dist/infrastructure/cli.js");
const manifest = join(base, "tests/apps/purchase.yaml");
const generate = (cwd: string, ...args: string[]) => execFileSync("node", [cli, "generate", "cloudflare-d1", "generated", manifest, ...args], { cwd, encoding: "utf8" });

test("generate lists every ref Procedure's Handlers key, then prompts typecheck", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-cli-handlers-"));
  try {
    const names = ["send-email", "app.notify"];
    const source = join(dir, "refs.yaml");
    await writeFile(source, names.map(name => JSON.stringify({ apiVersion: "cms.mantle.aotter.net/v2", kind: "Procedure", metadata: { name }, spec: { input: { type: "object" }, output: { type: "object" }, handler: { ref: "app.handler" } } })).join("\n---\n"));
    const output = execFileSync("node", [cli, "generate", "bun-sqlite", "generated", source], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(await readFile(join(dir, "generated/.mantle-inputs.json"), "utf8")).target).toBe("bun-sqlite"); // mantle bundle builds only Admin for it
    for (const name of names) expect(output).toContain(`Ref Procedure ${JSON.stringify(name)}: implement Handlers[${JSON.stringify(name)}].`);
    expect(output.trim().endsWith("Next: run tsc --noEmit; pass the handlers at store(db, caller, { handlers }).")).toBe(true);
    const sqlOnly = generate(dir);
    expect(sqlOnly).not.toContain("Ref Procedure");
    expect(sqlOnly).not.toContain("Next: run tsc");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("generate creates valid Wrangler config; edits preserve unrelated keys, comments and idempotence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-cli-"));
  try {
    expect(generate(dir)).toContain("Set name and compatibility_date");
    const config = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    expect(config).toEqual({
      name: "your-worker-name", compatibility_date: "2026-09-28", compatibility_flags: ["nodejs_compat"],
      main: "dist/worker/worker.js", no_bundle: true, find_additional_modules: true, base_dir: "dist/worker",
      rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }],
      build: { command: "mantle bundle src/worker.ts dist", watch_dir: ["src", "generated"] },
    });
    const original = '{\r\n\t// keep this comment\r\n\t"name": "existing", // same line\r\n\t"vars": { "VALUE": "untouched" },\r\n\t"d1_databases": [{ "binding": "DB", "database_id": "id" }],\r\n\t"compatibility_flags": ["other_flag" /* keep flag comment */],\r\n\t"main": "old.ts",\r\n\t"rules": [{ "type": "Text", "globs": ["**/*.md"] }, { "globs": ["**/*.js"], /* keep rule comment */ "fallthrough": true, "type": "ESModule" }],\r\n\t"build": { "cwd": "app" },\r\n}\r\n';
    await writeFile(join(dir, "wrangler.jsonc"), original);
    generate(dir, "--entry", "worker/index.ts", "--outdir", "build");
    const edited = await readFile(join(dir, "wrangler.jsonc"), "utf8");
    for (const line of original.split("\r\n").filter(line => /keep this|name|vars|d1_databases|rules/.test(line))) expect(edited).toContain(line);
    expect(edited).not.toMatch(/(?<!\r)\n/);
    expect(edited).toContain("/* keep flag comment */");
    const updated = parse(edited);
    expect(updated.compatibility_flags).toEqual(["other_flag", "nodejs_compat"]);
    expect(updated.main).toBe("build/worker/index.js");
    expect(updated.build).toEqual({ cwd: "app", command: "mantle bundle worker/index.ts build", watch_dir: ["worker", "generated"] });
    expect(updated.rules).toEqual([{ type: "Text", globs: ["**/*.md"] }, { type: "ESModule", globs: ["**/*.js"], fallthrough: true }]);
    generate(dir, "--entry", "worker/index.ts", "--outdir", "build");
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(edited);
    await rename(join(dir, "wrangler.jsonc"), join(dir, "wrangler.json"));
    generate(dir, "--entry", "worker/index.ts", "--outdir", "build");
    expect(await readFile(join(dir, "wrangler.json"), "utf8")).toBe(edited);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8").catch(() => undefined)).toBeUndefined();
    await mkdir(join(dir, "config"));
    for (const [name, version] of [["wrangler", "4.0.0"], ["miniflare", "4.20260102.0"], ["workerd", "1.20260102.0"]] as const) {
      await mkdir(join(dir, "node_modules", name), { recursive: true });
      await writeFile(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
    generate(dir, "--wrangler", "config/worker.jsonc");
    const nested = parse(await readFile(join(dir, "config/worker.jsonc"), "utf8"));
    expect(nested.compatibility_date).toBe("2026-01-02");
    expect(nested.main).toBe("../dist/worker/worker.js");
    expect(nested.build).toEqual({ command: "mantle bundle src/worker.ts dist", watch_dir: ["../src", "../generated"] });
    await writeFile(join(dir, "wrangler.jsonc"), '{"name": "bad",');
    const failed = spawnSync("node", [cli, "generate", "cloudflare-d1", "generated", manifest], { cwd: dir, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("valid JSONC");
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe('{"name": "bad",');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("generate leaves Wrangler TOML untouched and prints the exact build keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-toml-"));
  try {
    const original = '# keep\nname = "existing"\nmain = "src/worker.ts"\n';
    await writeFile(join(dir, "wrangler.toml"), original);
    const instructions = generate(dir);
    expect(await readFile(join(dir, "wrangler.toml"), "utf8")).toBe(original);
    for (const key of ['main = "dist/worker/worker.js"', 'no_bundle = true', 'find_additional_modules = true', 'base_dir = "dist/worker"', 'compatibility_flags = ["nodejs_compat"]', '[[rules]]', 'fallthrough = true', 'command = "mantle bundle src/worker.ts dist"', 'watch_dir = ["src","generated"]']) expect(instructions).toContain(key);
    expect(spawnSync("node", [cli, "generate", "cloudflare-postgres", "generated", manifest, "--wrangler", "wrangler.toml"], { cwd: dir }).status).toBe(0);
    expect(await readFile(join(dir, "wrangler.toml"), "utf8")).toBe(original);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("generate --admin manages only assets.directory, and --assets reaches the build command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-cli-assets-"));
  try {
    await writeFile(join(dir, "wrangler.jsonc"), '{ "name": "app", "assets": { "directory": "node_modules/old", "binding": "ASSETS", "run_worker_first": true } }');
    generate(dir, "--admin");
    const config = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    expect(config.assets).toEqual({ directory: "dist/client", binding: "ASSETS", run_worker_first: true });
    expect(config.build.command).toBe("mantle bundle src/worker.ts dist");
    generate(dir, "--admin", "--assets", "public");
    const custom = parse(await readFile(join(dir, "wrangler.jsonc"), "utf8"));
    expect(custom.assets.directory).toBe("public");
    expect(custom.build.command).toBe("mantle bundle src/worker.ts dist --assets public");
    await writeFile(join(dir, "wrangler.jsonc"), '{ "name": "api" }');
    generate(dir);
    expect(parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")).assets).toBeUndefined();
    await rm(join(dir, "wrangler.jsonc"));
    await writeFile(join(dir, "wrangler.toml"), 'name = "app"\n');
    expect(generate(dir, "--admin")).toContain('[assets]\ndirectory = "dist/client"');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(!process.env.MANTLE_NATIVE_TESTS)("workspace consumer bin: plain Wrangler deploy/dev run the split build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-workers-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "@aotter/mantle": `link:${base}` } }));
    execFileSync("pnpm", ["install", "--offline"], { cwd: dir, stdio: "pipe" });
    const bin = join(dir, "node_modules/.bin/mantle");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/worker.ts"), `export { default } from ${JSON.stringify(join(base, "tests/apps/auth/worker.ts"))};`);
    execFileSync(bin, ["generate", "cloudflare-d1", "generated", manifest], { cwd: dir, stdio: "pipe" });
    await mkdir(join(dir, "config"));
    execFileSync(bin, ["generate", "cloudflare-d1", "generated", manifest, "--wrangler", "config/worker.jsonc"], { cwd: dir, stdio: "pipe" });
    const env = { ...process.env, PATH: join(dir, "node_modules/.bin") + delimiter + process.env.PATH, WRANGLER_SEND_METRICS: "false" };
    const wrangler = join(base, "node_modules/wrangler/bin/wrangler.js");
    const dry = execFileSync("node", [wrangler, "deploy", "--config", "config/worker.jsonc", "--dry-run", "--outdir", "out"], { cwd: dir, env, encoding: "utf8", timeout: 60_000 });
    expect(dry).toContain("mantle bundle src/worker.ts dist");
    expect(dry).toMatch(/chunks\/.*\.js/);
    expect(dry).toContain("dry-run");
    const worker = spawn("node", [wrangler, "dev", "--config", "config/worker.jsonc", "--local", "--port", "0", "--inspector-port", "0"], { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(worker, "exit");
    let log = "";
    worker.stdout.on("data", chunk => { log += chunk; });
    worker.stderr.on("data", chunk => { log += chunk; });
    try {
      let url: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        url = log.match(/Ready on (http:\/\/[^\s]+)/)?.[1];
        if (url || worker.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      expect(url, log).toBeDefined();
      expect(log).toContain("mantle bundle src/worker.ts dist");
      expect(execFileSync("curl", ["--fail", "--silent", `${url}/public`], { encoding: "utf8", timeout: 5000 })).toBe("public");
    } finally {
      try { process.kill(-worker.pid!, "SIGTERM"); } catch {}
      await exited;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("generate no longer takes --admin-extensions, and a widget naming an extension contribution is refused",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"next-cli-extensions-"));
  try{
    const source=join(dir,"schema.json"),module=join(dir,"extensions.mjs");
    await writeFile(source,JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind:"Schema",metadata:{name:"posts"},spec:{title:"Posts",lifecycle:"operational",schema:{type:"object",properties:{title:{type:"string"}},required:["title"]}}}));
    await writeFile(module,"export const adminExtensions=[];");
    const args=[cli,"generate","bun-sqlite","generated",source];
    expect(spawnSync("node",args,{cwd:dir,encoding:"utf8"}).status).toBe(0);
    const flag=spawnSync("node",[...args,"--admin-extensions",module],{cwd:dir,encoding:"utf8"});expect(flag.status).toBe(1);expect(flag.stderr).toContain("--admin-extensions");
    await writeFile(source,JSON.stringify({apiVersion:"cms.mantle.aotter.net/v2",kind:"Schema",metadata:{name:"posts"},spec:{title:"Posts",lifecycle:"operational",schema:{type:"object",properties:{title:{type:"string"}},required:["title"]},uiSchema:{fields:{title:{widget:"audit/color"}}}}}));
    const named=spawnSync("node",args,{cwd:dir,encoding:"utf8"});expect(named.status).toBe(1);expect(named.stderr).toContain("widget must be 'textarea'");
  }finally{await rm(dir,{recursive:true,force:true});}
},30_000);
