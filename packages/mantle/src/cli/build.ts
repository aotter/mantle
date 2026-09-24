import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { cwd, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ValidateManifestsUseCase } from "@aotter/mantle-spec";
import { loadManifestsFromRoot, runValidate } from "@aotter/mantle-spec/cli";
import { compileRuntimePlan } from "@aotter/mantle-runtime";
import { runGenerate } from "./generate.js";

const types: Record<string, string> = {
  '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.webp': 'image/webp',
  '.xml': 'application/xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const inProject = (root: string, path: string) => {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error(`${path}: path must stay inside the project`);
  return absolute;
};
const assertRealPath = async (root: string, path: string) => {
  const actual = await realpath(path);
  inProject(root, actual);
};

export async function runBuild(rawArgs: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args: [...rawArgs], options: { help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
      stdout.write('Usage: mantle build\nRequires package.json mantleCloud version 1 and build:mantle script; writes .mantle/cloud-artifact.json.\n');
      return 0;
    }
    const root = cwd();
    const outputDir = join(root, '.mantle');
    await mkdir(outputDir, { recursive: true });
    await assertRealPath(root, outputDir);
    await rm(join(outputDir, 'cloud-artifact.json'), { force: true });
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    const config = pkg.mantleCloud;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('package.json: mantleCloud configuration is required');
    const fields = config as Record<string, unknown>;
    if (fields.version !== 1 || typeof fields.manifests !== 'string' || typeof fields.module !== 'string' || typeof fields.assets !== 'string')
      throw new Error('package.json: mantleCloud requires version 1, manifests, module and assets paths');
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    if (typeof scripts?.['build:mantle'] !== 'string') throw new Error('package.json: build:mantle script is required');
    if (pkg.packageManager !== 'pnpm@9.15.0') throw new Error('package.json: first Cloud recipe requires packageManager pnpm@9.15.0');
    const sdk = JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
    const deps = pkg.dependencies as Record<string, unknown> | undefined;
    if (deps?.['@aotter/mantle'] !== sdk.version) throw new Error(`package.json: @aotter/mantle must be pinned to ${sdk.version}`);
    const lockfile = await readFile(join(root, 'pnpm-lock.yaml'));
    const manifests = inProject(root, fields.manifests);
    const modulePath = inProject(root, fields.module);
    const assetsPath = inProject(root, fields.assets);
    await assertRealPath(root, manifests);
    if (await runValidate(['--manifests', manifests, '--no-source', '--phase', 'deploy']) !== 0) return 1;
    if (await runGenerate(['--manifests', manifests]) !== 0) return 1;
    execFileSync('pnpm', ['run', 'build:mantle'], { cwd: root, stdio: 'inherit' });
    await assertRealPath(root, modulePath);
    await assertRealPath(root, assetsPath);
    const loaded = await loadManifestsFromRoot(manifests);
    const validated = loaded.parsed ? ValidateManifestsUseCase.run({ parsed: loaded.parsed }) : null;
    if (!validated?.linked || loaded.parseErrors.length || validated.errorCount) throw new Error(`${manifests}: manifest validation failed`);
    const compiled = compileRuntimePlan(validated.linked);
    if (!compiled.ok) throw new Error(`${manifests}: RuntimePlan compilation failed`);
    const module = await readFile(modulePath, 'utf8');
    if (!module || Buffer.byteLength(module) > 1_000_000) throw new Error(`${fields.module}: module must be 1–1,000,000 bytes`);
    const assets: Record<string, { base64: string; type: string }> = {};
    async function collect(dir: string): Promise<void> {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile()) {
          const key = '/' + relative(assetsPath, path).split(sep).join('/');
          const type = types[extname(path).toLowerCase()];
          if (!type) throw new Error(`${path}: unsupported asset type`);
          const bytes = await readFile(path);
          if (bytes.length > 3_000_000) throw new Error(`${path}: asset exceeds 3 MB`);
          assets[key] = { base64: bytes.toString('base64'), type };
        } else throw new Error(`${path}: only regular asset files are supported`);
      }
    }
    await collect(assetsPath);
    if (Object.keys(assets).length > 100) throw new Error(`${fields.assets}: more than 100 assets`);
    const artifact = { version: 1, sdkVersion: sdk.version, recipe: { node: '22', pnpm: '9.15.0' },
      builder: { node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim() },
      lockfileSha256: sha256(lockfile), plan: compiled.value, module, assets };
    const output = JSON.stringify(artifact);
    if (Buffer.byteLength(output) > 6_000_000) throw new Error('Cloud artifact exceeds 6 MB');
    await writeFile(join(outputDir, 'cloud-artifact.json'), output);
    stdout.write(`.mantle/cloud-artifact.json sha256:${sha256(output)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mantle build: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
