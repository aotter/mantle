// Tagged JSON for SQL binds that travel between processes: bigint, Uint8Array and Date do not survive JSON.stringify.

export function encode(value) {
  if (typeof value === "bigint") return { $t: "bigint", v: value.toString() };
  if (value instanceof Uint8Array) return { $t: "bytes", v: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return { $t: "date", v: value.toISOString() };
  if (value === undefined) return { $t: "undefined" };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}

export function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    switch (value.$t) {
      case "bigint": return BigInt(value.v);
      case "bytes": return new Uint8Array(Buffer.from(value.v, "base64"));
      case "date": return new Date(value.v);
      case "undefined": return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

export const stringify = (value) => JSON.stringify(encode(value));
export const parse = (text) => decode(JSON.parse(text));
