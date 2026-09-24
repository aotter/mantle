import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const artifact = JSON.parse(await readFile('.mantle/cloud-artifact.json', 'utf8'));
assert.equal(artifact.version, 1);
assert.equal(artifact.plan.procedures.ping.manifest.spec.handler.ref, 'ping');
assert.ok(artifact.plan.views['published-notes']);
assert.match(artifact.module, /export const handlers/);
assert.equal(Buffer.from(artifact.assets['/site.css'].base64, 'base64').toString(),
  await readFile('public/site.css', 'utf8'));
console.log('Cloud build artifact contains the plan, handler module and public asset.');
