// `.mantle/hosting.json`: committed, strict, and never a place for secrets or
// endpoints. A hostile copy can at most name another project, which the first
// nextAction asks the user to confirm by name through Cloud MCP.
import { createHash } from 'node:crypto'
import { fail } from './output.mjs'
import { readInside, safeRelative, writeAtomic } from './files.mjs'

export const linkFile = '.mantle/hosting.json'
export const runtimes = Object.freeze(['mantle-cloud', 'cloudflare', 'chatgpt-sites'])
export const defaultHandlers = 'handlers/index.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const name = /^[a-z][a-z0-9-]{0,39}$/
export const slugRule = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/
const secretKey = /token|secret|password|passwd|key|auth|cookie|bearer|credential|session/i
// Long random-looking runs (letters and digits), hex digests, bearer and JWT prefixes; ids are UUIDs and exempt.
const tokenShaped = value => /Bearer\s|eyJ[A-Za-z0-9_-]{8,}/i.test(value) ||
  (value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').match(/[A-Za-z0-9_+/=-]{32,}/g) ?? [])
    .some(run => /[0-9]/.test(run) && /[A-Za-z]/.test(run) || /^[a-f0-9]+$/i.test(run))
const pointer = parts => parts.map(part => '/' + String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('')
const invalid = (parts, why) => fail('link_file_invalid', `${pointer(parts) || '/'}: ${why}`)

const configPath = (value, extensions) => safeRelative(value) && extensions.some(extension => value.endsWith(extension))
// key → [required, check]
const shapes = {
  'mantle-cloud': { runtime: [true, value => value === 'mantle-cloud'], organizationId: [true, value => uuid.test(value)],
    projectId: [true, value => uuid.test(value)], slug: [true, value => slugRule.test(value)],
    root: [false, value => safeRelative(value, { allowEmpty: true })],
    handlers: [false, value => safeRelative(value) && /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(value)], frontend: [false, value => value && typeof value === 'object' && !Array.isArray(value)] },
  cloudflare: { runtime: [true, value => value === 'cloudflare'], config: [false, value => configPath(value, ['.json', '.jsonc', '.toml'])] },
  'chatgpt-sites': { runtime: [true, value => value === 'chatgpt-sites'], config: [false, value => configPath(value, ['.json'])] },
}
const frontendShape = { dist: [false, value => safeRelative(value) && !value.split('/').some(part => ['.git', '.mantle', 'node_modules'].includes(part.toLowerCase()))], spa: [false, value => typeof value === 'boolean'],
  build: [false, value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value)] }

// Secret-shaped keys and token-shaped values anywhere, before any shape rule.
function scan(value, parts = []) {
  if (Array.isArray(value)) throw invalid(parts, 'arrays are not allowed')
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (tokenShaped(key)) throw invalid(parts, 'token-shaped key')
    if (secretKey.test(key)) throw invalid([...parts, key], 'secret-shaped key; the link file never holds credentials')
    scan(item, [...parts, key])
  }
  else if (typeof value === 'string' && tokenShaped(value)) throw invalid(parts, 'token-shaped value; the link file never holds credentials')
}

function check(object, shape, parts) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw invalid(parts, 'expected an object')
  for (const key of Object.keys(object)) if (!Object.hasOwn(shape, key)) throw invalid([...parts, key], 'unknown key (the link file has no endpoint, origin or credential settings)')
  for (const [key, [required, test]] of Object.entries(shape)) {
    if (!Object.hasOwn(object, key)) { if (required) throw invalid([...parts, key], 'required'); continue }
    if (!test(object[key])) throw invalid([...parts, key], 'invalid value')
  }
}

/** Validates a parsed link document and returns it unchanged. */
export function validateLink(doc) {
  scan(doc)
  check(doc, { schemaVersion: [true, value => value === 1], targets: [true, value => value && typeof value === 'object'] }, [])
  const names = Object.keys(doc.targets)
  if (!names.length || names.length > 20) throw invalid(['targets'], 'one to 20 targets')
  for (const target of names) {
    if (!name.test(target)) throw invalid(['targets', target], 'target names are lowercase letters, digits and dashes')
    const entry = doc.targets[target]
    if (!entry || typeof entry !== 'object' || !runtimes.includes(entry.runtime)) throw invalid(['targets', target, 'runtime'], `one of ${runtimes.join(', ')}`)
    check(entry, shapes[entry.runtime], ['targets', target])
    if (entry.frontend) check(entry.frontend, frontendShape, ['targets', target, 'frontend'])
  }
  return doc
}

export async function readLink(project) {
  const bytes = await readInside(project, linkFile, 64_000)
  if (!bytes) return null
  let doc
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')) }
  catch { throw fail('link_file_invalid', '/: not UTF-8 JSON') }
  return validateLink(doc)
}

export async function writeLink(project, doc) {
  await writeAtomic(project, linkFile, JSON.stringify(validateLink(doc), null, 2) + '\n')
}

/** The named (or only) target with defaults filled in. */
export function pickTarget(doc, requested) {
  if (!doc) throw fail('link_file_missing', `run link to create ${linkFile}`)
  const names = Object.keys(doc.targets)
  if (requested !== undefined && !Object.hasOwn(doc.targets, requested)) throw fail('link_target_unknown', `targets: ${names.join(', ')}`)
  if (requested === undefined && names.length > 1) throw fail('link_target_required', `pass --target with one of: ${names.join(', ')}`)
  const target = requested ?? names[0], entry = doc.targets[target]
  const hash = createHash('sha256').update(canonical(entry)).digest('hex')
  if (entry.runtime !== 'mantle-cloud') return { target, entry, hash }
  return { target, hash, entry: { ...entry, root: entry.root === '.' ? '' : entry.root ?? '', handlers: entry.handlers ?? defaultHandlers,
    frontend: { dist: entry.frontend?.dist ?? 'dist', spa: entry.frontend?.spa ?? false, build: entry.frontend?.build ?? null } } }
}

export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value)
