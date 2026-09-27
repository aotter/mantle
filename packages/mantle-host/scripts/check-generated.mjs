import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHost } from './build-host.mjs'

const expected = fileURLToPath(new URL('../../../skills/mantle-host/scripts/mantle-host.mjs', import.meta.url))
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
