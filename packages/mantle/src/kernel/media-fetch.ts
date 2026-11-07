/** One image from a public https URL for `upload_media`; loaded only when a call names one. */
import { ContractError } from "./contracts.js";
import { mediaError } from "./media.js";

const REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
const fail = (code: string, message: string) => mediaError(code, message, "media/source");

/** Reserved, private, shared, loopback, link-local, documentation, benchmark, multicast and broadcast IPv4 blocks. */
const BLOCKED_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];
/** Names that resolve inside a network, never on the public internet. */
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/;

/**
 * The URL when it names a public https host on the default port, else `MEDIA_SOURCE_REJECTED`. The WHATWG parser has
 * already normalized decimal, octal and hex IPv4 forms to dotted quads.
 * ponytail: names are checked, not resolved, so a public name that resolves to a private address passes. Workers cannot reach
 * private addresses; on another runtime, restrict the server's egress to the public internet.
 */
export function publicUrl(value: string, base?: string): URL {
  let url: URL;
  try { url = new URL(value, base); } catch { throw fail("MEDIA_SOURCE_REJECTED", "sourceUrl is not a URL"); }
  if (url.protocol !== "https:") throw fail("MEDIA_SOURCE_REJECTED", "only https URLs are fetched");
  if (url.username || url.password) throw fail("MEDIA_SOURCE_REJECTED", "a URL with credentials is refused");
  if (url.port) throw fail("MEDIA_SOURCE_REJECTED", "only the default https port is fetched");
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  // every IPv6 literal is refused: loopback, link-local, unique-local and IPv4-mapped forms all hide there
  if (host.startsWith("[")) throw fail("MEDIA_SOURCE_REJECTED", "IP address literals other than public IPv4 are refused");
  const quad = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (quad) {
    const ip = quad.slice(1).reduce((n, part) => n * 256 + Number(part), 0);
    if (BLOCKED_V4.some(([start, bits]) => Math.floor(ip / 2 ** (32 - bits)) === Math.floor(start / 2 ** (32 - bits)))) throw fail("MEDIA_SOURCE_REJECTED", "private, loopback, link-local and reserved addresses are refused");
  } else if (!host.includes(".") || LOCAL_NAME.test(host)) throw fail("MEDIA_SOURCE_REJECTED", `${host} is not a public host`);
  return url;
}

/** The accepted image types by their leading bytes: what was fetched decides the type, not its header. */
function sniff(b: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  return undefined;
}

/**
 * GET one image of at most `maxBytes` from a public https URL, following at most three redirects, each checked again.
 * Refusals are `MEDIA_SOURCE_REJECTED`, `MEDIA_VARIANT_SIZE_EXCEEDED` or `MEDIA_MIME_REJECTED`; an unreachable source is `MEDIA_SOURCE_FAILED`.
 */
export async function fetchImage(source: string, maxBytes: number): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly mimeType: string; readonly filename: string }> {
  let url = publicUrl(source), response: Response;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hops = 0; ; hops++) {
    try { response = await fetch(url, { redirect: "manual", signal, headers: { accept: "image/*" } }); }
    catch { throw fail("MEDIA_SOURCE_FAILED", `${url.host} could not be fetched`); }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    await response.body?.cancel();
    if (hops === REDIRECTS) throw fail("MEDIA_SOURCE_REJECTED", `more than ${REDIRECTS} redirects`);
    url = publicUrl(location, url.href);
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw fail("MEDIA_SOURCE_FAILED", `${url.host} answered ${response.status}`); }
  const declared = Number(response.headers.get("content-length"));
  const tooLarge = () => fail("MEDIA_VARIANT_SIZE_EXCEEDED", `the source is larger than the ${maxBytes} bytes this purpose allows`);
  if (declared > maxBytes) { await response.body.cancel(); throw tooLarge(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw tooLarge(); }
      chunks.push(next.value);
    }
  } catch (error) { if (error instanceof ContractError) throw error; throw fail("MEDIA_SOURCE_FAILED", `${url.host} stopped sending`); }
  const bytes = new Uint8Array(size);
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.byteLength), 0);
  const mimeType = sniff(bytes);
  if (!mimeType) throw fail("MEDIA_MIME_REJECTED", "the source is not a PNG, JPEG, GIF, WebP or AVIF image");
  let name = url.pathname.split("/").pop() ?? "";
  try { name = decodeURIComponent(name); } catch {}
  name = name.slice(0, 255);
  return { bytes, mimeType, filename: name || "upload" };
}
