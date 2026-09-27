export const initialBodyBuffer: number
export function readBoundedBody(stream: ReadableStream<Uint8Array> | null | undefined, limit: number, declared?: string | null): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }>
export function streamSha256(stream: ReadableStream<Uint8Array>): Promise<string>
