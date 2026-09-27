// Network access: only grant URLs on the fixed Cloud origins (or loopback for
// local Control and tests), each request announcing the host protocol. Grants
// are bearer capabilities: read from stdin, a file or the environment, never
// printed. Nothing in the link file or the environment can add an origin.
import { unzipSync } from 'fflate'
import { hostClientHeader, hostProtocol, hostProtocolHeader } from '../protocol.mjs'
import { fail } from './output.mjs'

export const cloudOrigins = Object.freeze(['https://cloud.mantle.tools', 'https://cloud-staging.mantle.tools'])
export const kitFiles = Object.freeze(['AGENT.md', 'frontend-contract.json', 'kit.json', 'mantle-client.ts', 'openapi.json'])
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const hex64 = /^[a-f0-9]{64}$/
const kitLimit = 4_000_000
const loopback = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)

/** Finds the object carrying `key` in a raw tool result, an MCP envelope or a Mantle `{ ok, data }` wrapper. */
export function unwrapResult(value, key, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null
  if (Object.hasOwn(value, key)) return value
  for (const field of ['structuredContent', 'result', 'data', 'output']) {
    const found = unwrapResult(value[field], key, depth + 1)
    if (found) return found
  }
  if (Array.isArray(value.content)) for (const item of value.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue
    try { const found = unwrapResult(JSON.parse(item.text), key, depth + 1); if (found) return found } catch { /* not JSON */ }
  }
  return null
}

/** Decodes piped or saved tool output: UTF-8 (BOM stripped) or UTF-16LE with BOM (Windows PowerShell). */
export function decodeInput(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes))
  if (view[0] === 0xff && view[1] === 0xfe) return new TextDecoder('utf-16le').decode(view.subarray(2))
  return new TextDecoder('utf-8').decode(view).replace(/^﻿/, '')
}

/** A grant URL on an allowed origin with exactly `path`; `query` allows a signed query (kit only). */
export function grantUrl(raw, path, { origin, query = false } = {}) {
  let url
  try { url = new URL(raw) } catch { throw fail('grant_url_invalid') }
  if ((!cloudOrigins.includes(url.origin) && !loopback(url)) || url.username || url.password || url.hash || url.pathname !== path ||
    (!query && url.search) || (origin && url.origin !== origin)) throw fail('grant_url_invalid', origin && url.origin !== origin ? 'grant URLs name different origins' : undefined)
  return url
}

/** Registers every credential-looking value of a parsed grant before anything can print. */
export function rememberCredentials(value, output, key = '', depth = 0) {
  if (depth > 12) return
  if (typeof value === 'string') {
    if (/authorization|token|secret|url/i.test(key) || /^Bearer /.test(value)) { output.remember(value); output.remember(value.replace(/^Bearer /, '')) }
    try { for (const item of new URL(value).searchParams.values()) output.remember(item) } catch { /* not a URL */ }
    // MCP text content wraps the result as a JSON string.
    if (value.startsWith('{')) try { rememberCredentials(JSON.parse(value), output, key, depth + 1) } catch { /* not JSON */ }
  } else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) rememberCredentials(item, output, name, depth + 1)
}

export function bearerOf(grant, output) {
  const value = grant?.authorization
  if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9._~+/=-]{16,}$/.test(value)) throw fail('grant_authorization_invalid')
  output.remember(value); output.remember(value.slice(7))
  return value
}

/** Fails closed when Cloud (or a grant) requires a newer protocol than this script speaks. */
export function checkProtocol(protocol) {
  if (protocol && typeof protocol === 'object' && Number(protocol.minimum) > hostProtocol.current)
    throw fail('client_outdated', `Cloud requires mantle-host protocol ${Number(protocol.minimum)}; this script speaks ${hostProtocol.current}`, 409)
}

async function boundedBody(response, limit) {
  const reader = response.body?.getReader()
  const chunks = []
  let length = 0
  if (reader) for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) { await reader.cancel(); throw fail('download_too_large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export function cloudClient({ fetch: request, client }) {
  const headers = { [hostProtocolHeader]: String(hostProtocol.current), [hostClientHeader]: client }
  async function call(url, { method = 'GET', authorization, body, type, timeout }) {
    let response
    try {
      response = await request(url, { method, body, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { ...headers, ...authorization ? { authorization } : {}, ...type ? { 'content-type': type } : {} } })
    } catch { throw fail('cloud_unreachable', undefined, 503) }
    if (response.status === 426) throw fail('client_outdated', 'Cloud answered 426 client_outdated', 409)
    return response
  }
  return {
    async json(url, init) {
      const response = await call(url, init)
      let body = null
      try { body = JSON.parse(new TextDecoder().decode(await boundedBody(response, 4_000_000))) } catch (error) { if (error.code === 'download_too_large') throw error }
      if (!response.ok) {
        const code = typeof body?.error === 'string' && /^[a-z0-9_]{1,100}$/.test(body.error) ? body.error
          : response.status === 403 ? 'upload_grant_rejected' : response.status === 413 ? 'upload_too_large' : response.status >= 500 ? 'cloud_unavailable' : 'cloud_request_failed'
        throw fail(code, `HTTP ${response.status}`, response.status >= 500 ? 503 : response.status === 409 ? 409 : 400)
      }
      if (!body || typeof body !== 'object') throw fail('cloud_response_invalid')
      checkProtocol(body.protocol)
      return body
    },
    async bytes(url, { limit, timeout }) {
      const response = await call(url, { timeout })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw fail(typeof body?.error === 'string' && /^[a-z0-9_]{1,100}$/.test(body.error) ? body.error : 'kit_download_failed', `HTTP ${response.status}`, response.status === 409 ? 409 : 400)
      }
      return boundedBody(response, limit)
    },
  }
}

/** Checks a downloaded kit ZIP against the ready response and returns its five fixed files. */
export function extractKit(bytes, { candidateId, contractHash, core }) {
  const names = []
  let entries
  try {
    entries = unzipSync(bytes, { filter: file => {
      if (!kitFiles.includes(file.name) || names.includes(file.name) || file.originalSize > kitLimit) throw fail('kit_entry_invalid')
      names.push(file.name)
      return true
    } })
  } catch (error) { throw error?.code ? error : fail('kit_invalid') }
  if (names.length !== kitFiles.length) throw fail('kit_entry_invalid', 'missing entries')
  let kit
  try { kit = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries['kit.json'])) } catch { throw fail('kit_invalid') }
  if (kit.candidateId !== candidateId || kit.contractHash !== contractHash) throw fail('kit_contract_mismatch')
  if (kit.coreVersion !== core.version || kit.coreRevision !== core.revision) throw fail('cli_core_mismatch', 'kit pins another Core', 409)
  return { kit, entries }
}

export const kitLimitBytes = kitLimit
