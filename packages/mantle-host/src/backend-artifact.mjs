// Backend artifact rules without esbuild, so the host bundle can share them
// and still resolve esbuild from the project at runtime.
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { assertClosedModule } from './closed-module.mjs'
import { parseCorePin } from './protocol.mjs'
import { CloudRuleError } from './static-artifact.mjs'

export const backendArtifactLimit = 2_000_000
/** esbuild options for one closed, Workers-compatible handler module. */
export const handlerBuildOptions = Object.freeze({ outfile: 'handlers.mjs', bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2022', metafile: true, logLevel: 'silent' })

/** Named YAML sources from `manifests/**` of a `path → bytes` map, with the path rules Cloud applies to sourceId. */
export function yamlSourcesFrom(files) {
  const sources = Object.keys(files).filter(path => path.startsWith('manifests/') && /\.ya?ml$/i.test(path.slice(path.lastIndexOf('/') + 1))).map(sourceId => {
    if (sourceId.split('/').some(part => part.startsWith('.'))) throw new CloudRuleError(400, 'manifest_path_hidden', sourceId)
    if (!/^[a-z0-9][a-z0-9_./-]*\.ya?ml$/.test(sourceId)) throw new CloudRuleError(400, 'manifest_path_invalid', `${sourceId}: manifest paths are lowercase ASCII`)
    const bytes = files[sourceId]
    // Cloud compares the source ZIP's raw bytes with this text, so a BOM the decoder dropped would never match.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new CloudRuleError(400, 'manifest_bom', sourceId)
    try { return { sourceId, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
    catch { throw new CloudRuleError(400, 'manifest_not_utf8', sourceId) }
  })
  if (!sources.length) throw new CloudRuleError(400, 'manifests_missing', 'no manifests/**/*.yaml')
  return sources.sort((a, b) => Buffer.compare(Buffer.from(a.sourceId), Buffer.from(b.sourceId)))
}

/** Named YAML sources under `<root>/manifests`, with the path rules Cloud applies to sourceId. */
export async function yamlSources(root) {
  const files = Object.create(null)
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) { if (/\.ya?ml$/i.test(entry.name)) files[relative(root, path).split(sep).join('/')] = new Uint8Array(await readFile(path)) }
      else throw new CloudRuleError(400, 'manifest_path_invalid', `${relative(root, path).split(sep).join('/')}: not a regular file`)
    }
  }
  await walk(join(root, 'manifests'))
  return yamlSourcesFrom(files)
}

/** The handler text of an esbuild result, or throws unless it is one closed module. */
export function closedHandlers(result) {
  const open = new CloudRuleError(400, 'backend_handlers_not_closed', 'the handler bundle must have no imports or dynamic imports')
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length) ||
      Object.values(result.metafile.inputs).some(input => input.imports.some(item => item.kind === 'dynamic-import'))) throw open
  // Non-literal import()/require() never reach the metafile; Cloud applies the same output scan.
  try { assertClosedModule(result.outputFiles[0].text) } catch { throw open }
  return result.outputFiles[0].text
}

/** The exact backend artifact bytes and their digest. */
export function serializeBackend({ sources, handlers, cliVersion, core }) {
  core = parseCorePin(core)
  if (!core) throw new CloudRuleError(400, 'core_pin_invalid')
  const text = JSON.stringify({ version: 1, sdkVersion: core.version, sdkRevision: core.revision, cliVersion, sources, handlers })
  const bytes = Buffer.byteLength(text)
  if (bytes > backendArtifactLimit) throw new CloudRuleError(400, 'backend_artifact_too_large', `${bytes} bytes; Cloud accepts ${backendArtifactLimit}`)
  return { text, bytes, sha256: createHash('sha256').update(text).digest('hex') }
}
