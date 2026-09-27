type Source = { sourceId: string; text: string }
export const sourceArchiveLimit: number
export const sourceExpandedLimit: number
export const sourceEntryLimit: number
export const sourcePathLimit: number
export const secretPathNames: readonly string[]
export const secretTemplateNames: readonly string[]
export const secretPathSuffixes: readonly string[]
export function secretSourcePath(path: string): boolean
export function sourcePathKey(path: string): string
export function canonicalSourceZip(files: Record<string, Uint8Array>): Uint8Array<ArrayBuffer>
export function sourceManifestMismatch(files: Record<string, Uint8Array>, sources: readonly Source[]): boolean
export function inspectSourceArchive(bytes: Uint8Array, sources: readonly Source[]): { files: string[]; expandedBytes: number }
export function omittablePath(path: unknown): boolean
