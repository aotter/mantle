import { realpath, writeFile } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { build } from 'esbuild'
import { backendArtifactLimit, closedHandlers, handlerBuildOptions, serializeBackend, yamlSources } from './backend-artifact.mjs'
import { cliPackage, cliVersion } from './version.mjs'

export { backendArtifactLimit, yamlSources }

/**
 * Packs named YAML sources and one closed, Workers-compatible handler module
 * into the exact backend artifact bytes. Writes `output` and a metafile next to
 * it for diagnostics, and returns the digest to reserve with Cloud.
 */
export async function packBackend(rootArg, handlerArg, outputArg) {
  const root = await realpath(resolve(rootArg))
  const handler = await realpath(resolve(root, handlerArg))
  const relativeHandler = relative(root, handler)
  if (relativeHandler === '..' || relativeHandler.startsWith('..' + sep)) throw new Error('Handler entry must be inside the project')
  const result = await build({ ...handlerBuildOptions, entryPoints: [handler] })
  const handlers = closedHandlers(result)
  const artifact = serializeBackend({ sources: await yamlSources(root), handlers, cliVersion: `${cliPackage}@${cliVersion}` })
  await writeFile(resolve(outputArg), artifact.text)
  await writeFile(resolve(outputArg + '.metafile.json'), JSON.stringify(result.metafile))
  return { output: resolve(outputArg), sha256: artifact.sha256, bytes: artifact.bytes, sources: JSON.parse(artifact.text).sources.length }
}
