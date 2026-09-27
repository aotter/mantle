export const backendArtifactLimit: number
export const handlerBuildOptions: Readonly<Record<string, unknown>>
export function yamlSourcesFrom(files: Record<string, Uint8Array>): { sourceId: string; text: string }[]
export function closedHandlers(result: { outputFiles: { text: string }[]; metafile: unknown }): string
export function serializeBackend(input: { sources: { sourceId: string; text: string }[]; handlers: string; cliVersion: string; core: { version: string; revision: string } }): { text: string; bytes: number; sha256: string }
export function yamlSources(root: string): Promise<{ sourceId: string; text: string }[]>
