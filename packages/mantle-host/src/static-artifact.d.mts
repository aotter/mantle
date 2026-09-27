export class CloudRuleError extends Error {
  constructor(status: 400 | 409 | 503, code: string, detail?: string)
  readonly status: 400 | 409 | 503
  readonly code: string
  readonly detail?: string
}
export const staticFrontendLimit: number
export const staticAssetLimit: number
export const staticAssetCount: number
export const staticMimeTypes: Readonly<Record<string, string>>
export const mantleReservedPathPrefixes: readonly string[]
export const mantleReservedWellKnownPrefix: string
export const mantleReservedExactPaths: readonly string[]
export const cloudReservedPrefixes: readonly string[]
export const cloudReservedExactPaths: readonly string[]
export const reservedWebPaths: readonly string[]
export function reservedStaticPath(path: string): boolean
export function inspectStaticAssets(assets: Record<string, { base64: string; type: string }>, reserved?: (path: string) => boolean): { bytes: number }
export function staticMimeFor(path: string): string | undefined
export function serializeStaticArtifact(files: Record<string, Uint8Array>, options: { sdkRevision: string; spa: boolean }): string
