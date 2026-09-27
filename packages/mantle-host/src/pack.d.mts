export const defaultSourceExcludes: readonly string[]
export function sha256(bytes: Uint8Array | string): string
export const ignoredDistFiles: readonly string[]
export function readDist(dist: string, ignored?: string[]): Promise<Record<string, Uint8Array>>
export function readSource(project: string, excludes?: string[]): Promise<{ project: string; files: Record<string, Uint8Array>; excluded: string[] }>
export function packFrontend(options: { project?: string; dist: string; out: string; spa?: boolean; kit?: string; backend?: string; exclude?: string[] }): Promise<{
  candidateId: string | null; contractHash: string | null; spa: boolean
  frontend: { path: string; sha256: string; bytes: number; assets: number; ignored: string[] }
  source: { path: string; sha256: string; bytes: number; files: number; excluded: string[] }
  warnings: string[]
}>
