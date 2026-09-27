import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHost } from './build-host.mjs'

const expected = fileURLToPath(new URL('../../../skills/mantle-host/scripts/mantle-host.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const core = JSON.parse(await readFile(new URL('../src/core.json', import.meta.url), 'utf8'))
let tag
try {
  tag = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/tags/v${core.version}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  // Shallow CI checkouts may not have the Core release tag.
}
if (tag && tag !== core.revision) throw new Error(`Core pin ${core.version} resolves to ${tag}, not ${core.revision}`)
const temp = await mkdtemp(join(tmpdir(), 'mantle-host-build-'))
try {
  const actual = (await buildHost(temp)).path
  if (!(await readFile(actual)).equals(await readFile(expected))) {
    throw new Error('skills/mantle-host/scripts/mantle-host.mjs is stale; run pnpm --filter @aotter/mantle-host build')
  }
  console.log('mantle-host generated script is current')
} finally {
  await rm(temp, { recursive: true, force: true })
}
