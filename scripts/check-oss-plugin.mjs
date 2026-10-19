import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
assert.equal(existsSync(join(root, '.mcp.json')), false, 'OSS plugin must not configure hosted MCP');
for (const file of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.cursor-plugin/plugin.json', '.copilot-plugin/plugin.json', '.agents/plugins/marketplace.json']) {
  const manifest = JSON.parse(read(file));
  assert.equal(manifest.mcpServers, undefined, file);
  assert.doesNotMatch(JSON.stringify(manifest), /mantle-cloud|cloud\.mantle\.tools|Cloud MCP|Mantle Cloud|\bCloud\b/i, file);
}
function check(path) {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) check(file);
    else assert.doesNotMatch(read(file), /mantle-cloud|cloud-host|cloud\.mantle\.tools|Cloud MCP|Mantle Cloud|\bCloud\b/i, file);
  }
}
check('skills');
assert.match(read('skills/mantle/SKILL.md'), /docs\/skills\/provision\/SKILL\.md/);
assert.match(read('skills/mantle/SKILL.md'), /mantle help local-testing/);
assert.match(read('docs/skills/provision/SKILL.md'), /Cloudflare Workers/);
console.log('check-oss-plugin: no hosted MCP/transport; local authoring and self-host deployment retained');
