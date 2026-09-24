import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseManifestSources, ValidateManifestsUseCase } from '@aotter/mantle-spec';
import { compileRuntimePlan } from '@aotter/mantle-runtime';

it('builds a pinned project into one plan + module + assets artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'mantle-cloud-build-'));
  const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
  try {
    mkdirSync(join(root, 'manifests'));
    writeFileSync(join(root, 'manifests/site.yaml'), readFileSync(fileURLToPath(new URL('../../../../docs/examples/host-minimal-worker/manifests/site.yaml', import.meta.url)), 'utf8') + `\n---\napiVersion: cms.mantle.aotter.net/v1\nkind: Procedure\nmetadata: { name: ping }\nspec:\n  input: { type: object, properties: {} }\n  output: { type: object, properties: { ok: { type: boolean } } }\n  handler: { kind: ref, ref: ping }\n`);
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'example', version: '1.0.0', private: true, packageManager: 'pnpm@9.15.0',
      dependencies: { '@aotter/mantle': '0.1.4' },
      mantleCloud: { version: 1, manifests: 'manifests', module: 'dist/app.mjs', assets: 'dist/public' },
      scripts: { 'build:mantle': 'node build.mjs' },
    }));
    const buildScript = `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist/public', {recursive:true}); writeFileSync('dist/app.mjs', 'export const handlers = {ping(){return {ok:true}}}; export default {fetch(){return new Response("ok")}}'); writeFileSync('dist/public/index.html', '<h1>Hello</h1>');`;
    writeFileSync(join(root, 'build.mjs'), buildScript);
    writeFileSync(join(root, 'build.mjs'), `${buildScript}\nmkdirSync('dist/public/admin', {recursive:true}); writeFileSync('dist/public/admin/index.html', '<h1>shadow</h1>');`);
    expect(spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' }).stderr).toContain('asset path is reserved');
    expect(existsSync(join(root, '.mantle/cloud-artifact.json'))).toBe(false);
    writeFileSync(join(root, 'build.mjs'), buildScript);
    rmSync(join(root, 'dist/public/admin'), { recursive: true });
    execFileSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' });
    const artifact = JSON.parse(readFileSync(join(root, '.mantle/cloud-artifact.json'), 'utf8'));
    expect(artifact.version).toBe(1);
    expect(artifact.sdkVersion).toBe('0.1.4');
    expect(artifact.plan.semanticFingerprint).toMatch(/^fnv1a64:[a-f0-9]{16}$/);
    expect(artifact.plan.procedures.ping.manifest.spec.handler.ref).toBe('ping');
    expect(Buffer.from(artifact.manifests['site.yaml'], 'base64')).toEqual(readFileSync(join(root, 'manifests/site.yaml')));
    const parsed = parseManifestSources({ sources: Object.entries(artifact.manifests).map(([sourceId, base64]) => ({ sourceId, text: Buffer.from(String(base64), 'base64').toString('utf8') })) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('uploaded manifests could not be parsed');
    const validated = ValidateManifestsUseCase.run({ parsed: parsed.value });
    expect(validated.errorCount).toBe(0);
    if (!validated.linked) throw new Error('uploaded manifests could not be linked');
    const compiled = compileRuntimePlan(validated.linked);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('uploaded manifests could not be compiled');
    expect(compiled.value).toEqual(artifact.plan);
    expect(artifact.module).toContain('export default');
    expect(Buffer.from(artifact.assets['/index.html'].base64, 'base64').toString()).toBe('<h1>Hello</h1>');
    const first = readFileSync(join(root, '.mantle/cloud-artifact.json'));
    execFileSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' });
    expect(readFileSync(join(root, '.mantle/cloud-artifact.json'))).toEqual(first);
    writeFileSync(join(root, 'build.mjs'), `${buildScript}\nimport { appendFileSync } from 'node:fs'; appendFileSync('manifests/site.yaml', '\\n# altered by build script\\n');`);
    expect(spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' }).stderr).toContain('changed Manifest');
    expect(existsSync(join(root, '.mantle/cloud-artifact.json'))).toBe(false);
    writeFileSync(join(root, 'build.mjs'), buildScript);
    symlinkSync('site.yaml', join(root, 'manifests/alias.yaml'));
    expect(spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' }).stderr).toContain('only regular Manifest files');
    rmSync(join(root, 'manifests/alias.yaml'));
    const invalid = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    invalid.mantleCloud.assets = '../outside';
    writeFileSync(join(root, 'package.json'), JSON.stringify(invalid));
    expect(spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' }).stderr).toContain('path must stay inside the project');
    expect(existsSync(join(root, '.mantle/cloud-artifact.json'))).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), 'mantle-cloud-outside-'));
    try {
      rmSync(join(root, '.mantle'), { recursive: true });
      writeFileSync(join(outside, 'cloud-artifact.json'), 'keep');
      symlinkSync(outside, join(root, '.mantle'), 'dir');
      expect(spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' }).stderr).toContain('path must stay inside the project');
      expect(readFileSync(join(outside, 'cloud-artifact.json'), 'utf8')).toBe('keep');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
