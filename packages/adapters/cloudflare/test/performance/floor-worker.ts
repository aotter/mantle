/** Standalone fixed-response floor; no Mantle, Hono, auth or storage imports. */
export default { fetch: () => new Response("ok", { headers: { "cache-control": "private, no-store" } }) };
