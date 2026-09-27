// `.mantle/host/state.json` (gitignored): ids, hashes and stages only. It holds
// no grant, bearer or secret and carries no deploy authority; losing it only
// means the next save mints new operationIds.
import { fail, redact } from './output.mjs'
import { readInside, writeAtomic } from './files.mjs'

export const hostDir = '.mantle/host'
export const stateFile = `${hostDir}/state.json`
export const outDir = target => `${hostDir}/out/${target}`

export async function loadState(project) {
  const bytes = await readInside(project, stateFile, 4_000_000)
  if (!bytes) return { schemaVersion: 1, targets: {} }
  let state
  try { state = JSON.parse(new TextDecoder().decode(bytes)) } catch { state = null }
  if (state?.schemaVersion !== 1 || !state.targets || typeof state.targets !== 'object') throw fail('state_invalid', `delete ${stateFile} and run save again`)
  return state
}

/** Persists before anything that depends on it is printed. */
export async function saveState(project, state) {
  const text = JSON.stringify(state, null, 2) + '\n'
  // Defence in depth: nothing credential-shaped is ever persisted.
  if (redact(text) !== text) throw fail('state_secret_refused')
  await writeAtomic(project, stateFile, text, 0o600)
}

export const targetState = (state, target) => (state.targets[target] ??= { confirmedLink: null, pending: null, versions: [], deploys: {}, rollbacks: {} })
