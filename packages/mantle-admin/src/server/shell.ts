/** The Admin SPA shell for an app that serves `@aotter/mantle-admin/admin` itself: anti-framing, no-store HTML and path refusals. */
const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
/** `assets` fetches one built file by its path under /admin (`index.html`, `assets/app.js`); a 404 means missing. */
/** `authBasePath`: the Better Auth instance Admin signs in with, when it is not the default `/api/auth` (e.g. a staff instance). */
export async function adminShell(request: Request, assets: (path: string) => Response | Promise<Response>, options: { readonly authBasePath?: string } = {}): Promise<Response | undefined> {
    const authBase = options.authBasePath?.replace(/\/+$/, "");
    if (authBase !== undefined && !/^(\/[A-Za-z0-9_-]+)+$/.test(authBase))
        throw new Error("authBasePath must be a path such as /api/auth/staff.");
    const url = new URL(request.url);
    if (request.method !== "GET" || (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")))
        return undefined;
    // the encoded separators and control characters never name a file; a traversal segment is refused after decoding too, and
    // so is a still-encoded one (`%252e%252e` decodes to `%2e%2e`, which a callback's `new URL("/admin/" + path, url)` turns
    // into `..`, as it turns `\t..` into `..` by dropping the tab)
    const raw = url.pathname.slice("/admin/".length);
    let rel: string;
    try { rel = decodeURIComponent(raw); }
    catch { return notFound(); }
    if (/%2f|%5c|\\/i.test(raw) || /[\x00-\x1f\x7f]/.test(rel) || rel.split("/").some(segment => /^(?:\.|%2e){1,2}$/i.test(segment)))
        return notFound();
    const fetchAsset = async (path: string) => { const response = await assets(path); return response.status === 404 ? null : response; };
    const file = rel.split("/").pop()!.includes(".") ? await fetchAsset(rel) : null;
    // an unknown path is a client route (`/admin/members/a.b@x.test` too), which the shell answers; the MCP App is a file the
    // server reads for a host (`adminMcpApps`), never a route: served when built, with the shell's anti-framing, else missing
    const response = file ?? (rel.startsWith("assets/") || rel === "mcp-app.html" ? null : await fetchAsset("index.html"));
    if (!response)
        return notFound();
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    // the preview is framed by Admin itself, and only HTML pages are the shell
    if (!/^text\/html\b/i.test(headers.get("content-type") ?? "") || rel === "preview.html")
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    headers.append("content-security-policy", "frame-ancestors 'none'");
    headers.set("x-frame-options", "DENY");
    headers.set("cache-control", "no-store");
    if (!authBase || authBase === "/api/auth")
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    headers.delete("content-length");
    const html = (await response.text()).replace("</head>", `<meta name="mantle-auth-base" content="${authBase}"></head>`);
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
}
