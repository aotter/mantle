#!/usr/bin/env node
// Exercise the plugin as installed: no mantle-home checkout or dependency.
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
assert.equal(provenance.repository, 'https://github.com/aotter/mantle-home');
assert.match(provenance.commit, /^[a-f0-9]{40}$/);
assert.equal(provenance.protocol, 3);
assert.equal(createHash('sha256').update(readFileSync(join(skill, 'scripts/cloud-host.mjs'))).digest('hex'), provenance.sha256);

const project = mkdtempSync(join(tmpdir(), 'mantle-plugin-consumer-'));
const run = (args, input) => {
  const result = spawnSync(process.execPath, args, { cwd: project, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
};
const line = (args, input) => JSON.parse(run([helper, ...args, '--json'], input).trim().split('\n').at(-1));
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
  assert.equal(line(['link', '--organization', organizationId, '--project', projectId, '--slug', 'plugin-check']).state, 'linked');
  // No Git mode is explicit for this disposable fixture. The first save must
  // negotiate with Cloud before packing; the plugin carries no static Core pin.
  const first = line(['save', '--no-git']);
  assert.equal(first.nextAction.tool, 'cloud_host_contract');
  assert.deepEqual(first.nextAction.arguments, { projectId });
  assert.ok(first.nextAction.command.includes(helper));
  const core = JSON.parse(readFileSync(join(root, 'packages/mantle/package.json'), 'utf8'));
  const contract = { projectId, core: { version: core.version, revision: 'a'.repeat(40) }, protocol: { current: 3, minimum: 3 } };
  const packed = line(['save', '--resume', '--grant', '-'], JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: contract }) }] }));
  assert.equal(packed.nextAction.tool, 'cloud_backend_upload');
  assert.ok(packed.nextAction.command.includes(helper));
  assert.equal(packed.nextAction.requires[0].tool, 'query_view_member_project');
  assert.equal(JSON.parse(readFileSync(join(project, '.mantle/host/out/production/backend.json'), 'utf8')).version, 2);
  assert.equal(line(['status']).nextAction.arguments.operationId, packed.nextAction.arguments.operationId);
  console.log('check-cloud-plugin: packaged helper negotiates Core, compiles v2, and resumes the same MCP operation');
} finally {
  rmSync(project, { recursive: true, force: true });
}
