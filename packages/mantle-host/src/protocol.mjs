// Host-script protocol shared by Control and mantle-host. A client that
// announces a version below `minimum` in x-mantle-host-protocol gets 426
// client_outdated; the script fails closed on that answer.
export const hostProtocol = Object.freeze({ current: 2, minimum: 2 })
export const hostProtocolHeader = 'x-mantle-host-protocol'
export const hostClientHeader = 'x-mantle-host-client'
export function parseCorePin(value) {
  return value && typeof value === 'object' && typeof value.version === 'string' && typeof value.revision === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) && /^[0-9a-f]{40}$/.test(value.revision)
    ? { version: value.version, revision: value.revision } : null
}
