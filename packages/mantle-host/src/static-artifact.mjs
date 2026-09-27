// Static frontend artifact v2 rules shared by Mantle Cloud and the CLI. Cloud
// wraps the thrown CloudRuleError in its own error type; the CLI reports it
// before any bytes leave the machine.
export class CloudRuleError extends Error {
  constructor(status, code, detail) {
    super(code)
    this.status = status
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export const staticFrontendLimit = 9_000_000
export const staticAssetLimit = 6_000_000
export const staticAssetCount = 100

export const staticMimeTypes = Object.freeze({
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
  '.wasm': 'application/wasm', '.map': 'application/json',
})
const mime = new Map(Object.entries(staticMimeTypes))

// Mirrors isMantleReservedPath of @aotter/mantle-cloudflare with the default
// auth base; Control's tests pin these lists to the adapter's exports.
export const mantleReservedPathPrefixes = Object.freeze(['/admin', '/_mantle', '/api/auth', '/api/views', '/oauth', '/mcp'])
export const mantleReservedWellKnownPrefix = '/.well-known/oauth'
export const mantleReservedExactPaths = Object.freeze(['*', '/*'])
// Cloud-owned namespaces and Mantle Web outputs that always win over assets.
export const cloudReservedPrefixes = Object.freeze(['/api', '/__cloud', '/_app'])
export const cloudReservedExactPaths = Object.freeze(['/terms', '/privacy'])
export const reservedWebPaths = Object.freeze(['/favicon.ico', '/robots.txt', '/llms.txt', '/llms-full.txt', '/sitemap.xml', '/sitemap-index.xml'])
const reservedWeb = new Set(reservedWebPaths)

const owned = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}*`) || path.startsWith(`${prefix}{`)

/** True when `path` (already NFC + lowercased) belongs to Mantle or Cloud rather than static assets. */
export function reservedStaticPath(path) {
  return mantleReservedExactPaths.includes(path) || mantleReservedPathPrefixes.some(prefix => owned(path, prefix)) ||
    path.startsWith(mantleReservedWellKnownPrefix) || cloudReservedPrefixes.some(prefix => path === prefix || path.startsWith(prefix + '/')) ||
    cloudReservedExactPaths.includes(path) || reservedWeb.has(path) || /^\/(?:\.well-known|terms|privacy)\//.test(path)
}

const textual = type => type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml'

/**
 * Checks the asset map of a v2 artifact exactly as Cloud does before it stores
 * any byte. `reserved` lets Cloud add its own route predicate on top.
 */
export function inspectStaticAssets(assets, reserved = () => false) {
  const entries = Object.entries(assets)
  if (!entries.length || entries.length > staticAssetCount || !Object.hasOwn(assets, '/index.html')) throw new CloudRuleError(400, 'static_assets_invalid')
  let total = 0
  const names = new Set()
  for (const [path, asset] of entries) {
    const normalized = path.normalize('NFC').toLowerCase()
    if (!path.startsWith('/') || path.endsWith('/') || path !== path.normalize('NFC') ||
      /[%?#\\\u0000- ]/.test(path) || path.split('/').slice(1).some(part => !part || part === '.' || part === '..') ||
      new URL(path, 'https://tenant.invalid').pathname !== path || names.has(normalized) ||
      reservedStaticPath(normalized) || reserved(normalized))
      throw new CloudRuleError(400, 'static_asset_path_invalid', path)
    names.add(normalized)
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    if (asset.type !== mime.get(extension)) throw new CloudRuleError(400, 'static_asset_mime_invalid', path)
    let bytes
    try { bytes = atob(asset.base64) }
    catch { throw new CloudRuleError(400, 'static_asset_base64_invalid', path) }
    if (btoa(bytes) !== asset.base64) throw new CloudRuleError(400, 'static_asset_base64_invalid', path)
    total += bytes.length
    if (total > staticAssetLimit) throw new CloudRuleError(400, 'static_assets_too_large', path)
    if (textual(asset.type)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes, character => character.charCodeAt(0))) }
      catch { throw new CloudRuleError(400, 'static_asset_utf8_invalid', path) }
    }
  }
  return { bytes: total }
}

/** The MIME type Cloud requires for an asset path, or undefined when the extension is unsupported. */
export const staticMimeFor = path => mime.get(path.slice(path.lastIndexOf('.')).toLowerCase())

function base64(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/**
 * Serializes asset bytes into the exact v2 JSON text the CLI uploads. Paths are
 * sorted by UTF-16 code unit so the same files always hash the same.
 */
export function serializeStaticArtifact(files, { sdkRevision, spa }) {
  const assets = Object.create(null)
  for (const path of Object.keys(files).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const type = staticMimeFor(path)
    if (!type) throw new CloudRuleError(400, 'static_asset_mime_invalid', path)
    assets[path] = { base64: base64(files[path]), type }
  }
  const text = JSON.stringify({ version: 2, sdkRevision, spa: Boolean(spa), assets })
  if (new TextEncoder().encode(text).byteLength > staticFrontendLimit) throw new CloudRuleError(400, 'static_frontend_too_large')
  inspectStaticAssets(assets)
  return text
}
