export const hostProtocol: Readonly<{ current: number; minimum: number }>
export const hostProtocolHeader: string
export const hostClientHeader: string
export function parseCorePin(value: unknown): { version: string; revision: string } | null
