// Host-script protocol shared by Control and mantle-host. A client that
// announces a version below `minimum` in x-mantle-host-protocol gets 426
// client_outdated; the script fails closed on that answer.
export const hostProtocol = Object.freeze({ current: 1, minimum: 1 })
export const hostProtocolHeader = 'x-mantle-host-protocol'
export const hostClientHeader = 'x-mantle-host-client'
