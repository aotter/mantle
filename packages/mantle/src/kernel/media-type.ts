/** Media type rules shared by the media library, its R2 adapter and the purpose validator. */

/** A lowercase `type/subtype` of RFC 6838 restricted names, without parameters: it is sent in signed headers. */
export const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** A purpose slot token: a media type, `type/*` or `*\/*`. */
export const validAccept = (token: string): boolean => token === "*/*" || MEDIA_TYPE.test(token.replace(/\/\*$/, "/x"));

/** The token of `tokens` that takes `mimeType`: the type itself, else its `type/*`, else `*\/*`. It does not check the type. */
export const acceptedBy = (tokens: readonly string[], mimeType: string): string | undefined =>
  [mimeType, mimeType.replace(/\/.*/, "/*"), "*/*"].find(token => tokens.includes(token));

/** Shown in place without running the file's own script: raster images, PDF, audio and video. Anything else downloads. */
export const inline = (mimeType: string): boolean =>
  /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/.+|video\/.+)$/.test(mimeType);

/**
 * Rendered by a browser as a document that can run script, or run as script: HTML, any XML (every `+xml` subtype and
 * `xml` under any top-level type, SVG, XHTML and XSLT among them), JavaScript and multipart/x-mixed-replace.
 */
export const active = (mimeType: string): boolean =>
  /^(text\/html|[^/]+\/([^/]*\+)?xml|text\/xsl|(text|application)\/(x-)?(java|ecma)script|text\/(javascript1\.[0-5]|jscript|livescript)|multipart\/x-mixed-replace)$/.test(
    mimeType,
  );
