import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const artifact = JSON.parse(await readFile('.mantle/cloud-artifact.json', 'utf8'));
assert.equal(artifact.version, 1);
assert.equal(Buffer.from(artifact.manifests['site.yaml'], 'base64').toString(),
  await readFile('manifests/site.yaml', 'utf8'));
assert.equal(artifact.plan.procedures.ping.manifest.spec.handler.ref, 'ping');
assert.ok(artifact.plan.views['published-notes']);
assert.match(artifact.module, /export const handlers/);
const app = await import(`data:text/javascript;base64,${Buffer.from(artifact.module).toString('base64')}`);
assert.deepEqual(app.handlers.ping(), { ok: true });
const page = await app.default.fetch(new Request('https://example.test/'));
assert.equal(page.status, 200);
assert.match(await page.text(), /<h1>Notes<\/h1>/);
assert.equal(Buffer.from(artifact.assets['/site.css'].base64, 'base64').toString(),
  await readFile('public/site.css', 'utf8'));
console.log('Cloud build artifact loads its handler and frontend and contains the public asset.');
