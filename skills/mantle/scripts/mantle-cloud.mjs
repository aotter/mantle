#!/usr/bin/env node
// One public entry for the plugin's offline readiness check and Cloud workflow.
// Cloud's shared rules are generated in cloud-host.mjs; do not edit that file.
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'check') {
  await import('./mantle-check.mjs');
} else {
  const { main } = await import('./cloud-host.mjs');
  process.exitCode = await main(process.argv.slice(2), { scriptPath: fileURLToPath(import.meta.url) });
}
