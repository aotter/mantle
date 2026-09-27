export function main(args: string[], io?: {
  cwd?: string; env?: Record<string, string | undefined>; fetch?: typeof fetch; stdin?: () => Promise<Uint8Array | string>
  write?: (text: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void>; scriptPath?: string
  timeouts?: { backend?: number; pairing?: number }
}): Promise<number>
