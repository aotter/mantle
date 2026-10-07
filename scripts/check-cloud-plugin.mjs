#!/usr/bin/env node
// Exercise the plugin as installed: no private source checkout or dependency.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const skill = join(root, 'skills/mantle');
const helper = join(skill, 'scripts/mantle-cloud.mjs');
const provenance = JSON.parse(readFileSync(join(skill, 'scripts/VENDORED.json'), 'utf8'));
assert.deepEqual(Object.keys(provenance).sort(), ['artifact', 'protocol', 'sha256']);
assert.equal(provenance.artifact, 'cloud-host.mjs');
assert.equal(provenance.protocol, 5);
assert.equal(createHash('sha256').update(readFileSync(join(skill, 'scripts/cloud-host.mjs'))).digest('hex'), provenance.sha256);

const project = mkdtempSync(join(tmpdir(), 'mantle-plugin-consumer-'));
const run = (args, input) => {
  const result = spawnSync(process.execPath, args, { cwd: project, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
const line = (args, input) => JSON.parse(run([helper, ...args, '--json'], input).trim().split('\n').at(-1));
const failure = (args, input) => {
  const result = spawnSync(process.execPath, [helper, ...args, '--json'], { cwd: project, input, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
};
try {
  mkdirSync(join(project, 'manifests'));
  mkdirSync(join(project, 'node_modules/@aotter'), { recursive: true });
  symlinkSync(join(root, 'packages/mantle'), join(project, 'node_modules/@aotter/mantle'), 'dir');
  writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
  const example = readFileSync(join(root, 'docs/handbook/start/quickstart-worker.md'), 'utf8');
  const yaml = [...example.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(match => match[1]);
  assert.ok(yaml.some(text => text.includes('apiVersion: cms.mantle.aotter.net/v2')));
  yaml.forEach((text, i) => writeFileSync(join(project, 'manifests', `${i}.yaml`), text));
  run([join(root, 'packages/mantle/dist/cli/main.js'), 'generate', '--identity', 'none', '--features', 'web']);
  assert.equal(JSON.parse(run([helper, 'check'])).cloud, 'not_checked');
  assert.equal(line(['version']).protocol, provenance.protocol);
  const organizationId = '0199aaaa-0000-7000-8000-000000000001';
  const projectId = '0199aaaa-0000-7000-8000-000000000002';
  mkdirSync(join(project, '.mantle'), { recursive: true });
  writeFileSync(join(project, '.mantle/hosting.json'), JSON.stringify({ schemaVersion: 1, targets: { production: { runtime: 'mantle-cloud', organizationId, projectId, slug: 'plugin-check', frontend: { dist: 'dist', spa: false } } } }));
  writeFileSync(join(project, '.gitignore'), 'node_modules/\ndist/\n.mantle/host/\n');
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Plugin check', '-c', 'user.email=check@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('add', '-A'); git('commit', '-m', 'Generated source');
  const commit = git('rev-parse', 'HEAD');
  const core = JSON.parse(readFileSync(join(root, 'packages/mantle/package.json'), 'utf8'));
  const pin = { version: core.version, revision: 'a'.repeat(40) };
  const contract = { projectId, core: pin, protocol: { current: 5, minimum: 5 } };
  const packed = line(['pack', 'backend', '--contract', '-'], JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: contract }) }] }));
  assert.equal(packed.cloud, 'not_checked');
  assert.equal(packed.commit, commit);
  const artifact = packed.files['backend.json'];
  assert.equal(createHash('sha256').update(readFileSync(join(project, artifact.path))).digest('hex'), artifact.sha256);
  assert.equal(JSON.parse(readFileSync(join(project, artifact.path), 'utf8')).version, 2);
  assert.equal(failure(['pack', 'backend', '--contract', '-'], JSON.stringify({ ...contract, projectId: '0199aaaa-0000-7000-8000-000000000009' })).error, 'grant_project_mismatch');
  const first = line(['pack', 'backend', '--contract', '-'], JSON.stringify(contract));
  assert.deepEqual(first.files, packed.files);
  assert.equal(failure(['save']).error, 'usage');
  assert.equal(failure(['pack', 'frontend', '--kit', '.mantle/host/kit', '--candidate', '0199aaaa-0000-7000-8000-000000000003', '--commit', commit]).error, 'usage');
  mkdirSync(join(project, '.mantle/host/kit'), { recursive: true });
  mkdirSync(join(project, 'dist'), { recursive: true });
  const candidateId = '0199aaaa-0000-7000-8000-000000000003';
  writeFileSync(join(project, '.mantle/host/kit/kit.json'), JSON.stringify({ candidateId, contractHash: 'b'.repeat(64), coreVersion: pin.version, coreRevision: pin.revision }));
  const origin = 'https://plugin-check.mantle.tools';
  const frontendArgs = ['pack', 'frontend', '--kit', '.mantle/host/kit', '--candidate', candidateId, '--commit', commit, '--backend-sha256', artifact.sha256, '--origin', origin];
  writeFileSync(join(project, 'dist/index.html'), '<div id="root"></div>');
  assert.equal(failure(frontendArgs).error, 'website_acceptance_failed');
  const html = `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Plugin check</title><meta name="description" content="Synthetic static website"><link rel="canonical" href="${origin}/"><meta property="og:title" content="Plugin check"><meta property="og:type" content="website"><meta property="og:url" content="${origin}/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script></head><body><main><h1>Plugin check</h1><p>Synthetic public content.</p></main></body></html>`;
  writeFileSync(join(project, 'dist/index.html'), html);
  writeFileSync(join(project, 'dist/sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${origin}/</loc></url>\n</urlset>\n`);
  writeFileSync(join(project, 'dist/robots.txt'), `User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ${origin}/sitemap.xml\n`);
  const frontend = line(frontendArgs);
  assert.equal(frontend.website.status, 'passed');
  assert.equal(frontend.website.dynamicContentSeo, 'unsupported');
  assert.equal(frontend.website.runtimeContract.otp, 'cloud_wired_not_exercised');
  writeFileSync(join(project, 'README.md'), 'Dirty source\n');
  assert.equal(failure(['pack', 'backend', '--contract', '-'], JSON.stringify(contract)).error, 'worktree_dirty');
  git('add', 'README.md'); git('commit', '-m', 'Commit synthetic note');
  writeFileSync(join(project, '.env'), 'SYNTHETIC=not-real\n');
  git('add', '-f', '.env'); git('commit', '-m', 'Synthetic history guard');
  git('rm', '.env'); git('commit', '-m', 'Remove synthetic file');
  assert.equal(failure(['source', '--project', projectId, '--grant', '-'], JSON.stringify({ authMode: 'http_extra_header', protocol: { current: 5, minimum: 5 } })).error, 'source_history_secret_path');
  console.log('check-cloud-plugin: installed offline packer negotiates Cloud pin, preserves commit/hash identity, refuses wrong project and dirty source; MCP owns lifecycle');
} finally {
  rmSync(project, { recursive: true, force: true });
}
