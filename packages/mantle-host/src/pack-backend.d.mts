export const backendArtifactLimit: number
export function yamlSources(root: string): Promise<{ sourceId: string; text: string }[]>
export function packBackend(root: string, handler: string, output: string, core: { version: string; revision: string }): Promise<{ output: string; sha256: string; bytes: number; sources: number }>
