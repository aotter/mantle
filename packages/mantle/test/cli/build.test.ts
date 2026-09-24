import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('builds a pinned project into one plan + module + assets artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'mantle-cloud-build-'));
  const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
  try {
    mkdirSync(join(root, 'manifests'));
    writeFileSync(join(root, 'manifests/site.yaml'), readFileSync(fileURLToPath(new URL('../../../../docs/examples/host-minimal-worker/manifests/site.yaml', import.meta.url))));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'example', version: '1.0.0', private: true, packageManager: 'pnpm@9.15.0',
      dependencies: { '@aotter/mantle': '0.1.4' },
      mantleCloud: { version: 1, manifests: 'manifests', module: 'dist/app.mjs', assets: 'dist/public' },
      scripts: { 'build:mantle': 'node build.mjs' },
    }));
    writeFileSync(join(root, 'build.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist/public', {recursive:true}); writeFileSync('dist/app.mjs', 'export default {fetch(){return new Response("ok")}}'); writeFileSync('dist/public/index.html', '<h1>Hello</h1>');`);
    execFileSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' });
    const artifact = JSON.parse(readFileSync(join(root, '.mantle/cloud-artifact.json'), 'utf8'));
    expect(artifact.version).toBe(1);
    expect(artifact.sdkVersion).toBe('0.1.4');
    expect(artifact.plan.semanticFingerprint).toMatch(/^fnv1a64:[a-f0-9]{16}$/);
    expect(artifact.module).toContain('export default');
    expect(Buffer.from(artifact.assets['/index.html'].base64, 'base64').toString()).toBe('<h1>Hello</h1>');
    const first = readFileSync(join(root, '.mantle/cloud-artifact.json'));
    execFileSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' });
    expect(readFileSync(join(root, '.mantle/cloud-artifact.json'))).toEqual(first);
    const invalid = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    invalid.mantleCloud.assets = '../outside';
    writeFileSync(join(root, 'package.json'), JSON.stringify(invalid));
    expect(spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8' }).stderr).toContain('path must stay inside the project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
