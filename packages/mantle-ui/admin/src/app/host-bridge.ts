/** The opt-in Admin document uses only its immediate same-origin host; never live HTTP. */
import type {} from "./frame-policy";

if (window.parent !== window) {
  const script = document.currentScript as HTMLScriptElement | null;
  const base = script?.dataset.basePath ?? "/builder/admin";
  if (base.startsWith("//") || !/^\/[a-zA-Z0-9/_-]+$/.test(base) || window.parent.location.origin !== location.origin) {
    throw new Error("Admin preview requires an immediate same-origin host.");
  }
  const origin = location.origin;
  const adminPath = (path: string) => path === "/admin" || path.startsWith("/admin/");
  if (location.pathname === base || location.pathname.startsWith(base + "/")) {
    history.replaceState(null, "", "/admin" + location.pathname.slice(base.length) + location.search + location.hash);
  } else throw new Error("Admin preview document is outside its mount.");

  window.fetch = async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), location.href), init);
    const url = new URL(request.url);
    if (url.origin !== origin || !url.pathname.startsWith("/admin/api/")) throw new TypeError("Not an Admin preview request.");
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    if (body && body.byteLength > 1024 * 1024) throw new TypeError("Admin preview request is too large.");
    request.signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = (error?: Error, response?: Response) => {
        clearTimeout(timeout); request.signal.removeEventListener("abort", abort);
        channel.port1.close(); channel.port2.close();
        if (error) reject(error); else resolve(response!);
      };
      const abort = () => finish(new Error("Admin preview request cancelled; check state before retrying."));
      const timeout = setTimeout(() => finish(new Error("Admin preview request timed out; check state before retrying.")), 30_000);
      request.signal.addEventListener("abort", abort, { once: true });
      channel.port1.onmessage = ({ data }) => {
        try {
          if (data?.ok !== true) throw new Error(data?.error ?? "Admin preview request failed.");
          finish(undefined, new Response([204, 205, 304].includes(data.status) || request.method === "HEAD" ? null : data.body, { status: data.status, headers: data.headers }));
        } catch (error) { finish(error instanceof Error ? error : new Error("Invalid Admin preview response.")); }
      };
      try { window.parent.postMessage({ type: "mantle:host-api:request", protocolVersion: 1,
        request: { url: url.href, method: request.method, headers: [...request.headers], body } }, origin, [channel.port2]); }
      catch (error) { finish(error instanceof Error ? error : new Error("Admin preview bridge failed.")); }
    });
  };
  window.__MANTLE_ADMIN_PREVIEW__ = { fetch: window.fetch, mode: script?.dataset.mode === "design" ? "design" : "runtime" };
  window.addEventListener("message", (event) => {
    if (event.origin !== origin || event.source !== window.parent || event.data?.type !== "mantle:host-api:reload") return;
    if (adminPath(location.pathname) && !location.pathname.startsWith("/admin/api/")) {
      location.replace(base + location.pathname.slice("/admin".length) + location.search + location.hash);
    }
  });
}
