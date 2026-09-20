declare global {
  interface Window {
    /** Installed by a same-origin sandbox host before preview.html boots. */
    __MANTLE_ADMIN_PREVIEW__?: { fetch: typeof fetch };
  }
}

export function canRenderAdmin(win: Window, preview: boolean): boolean {
  if (!preview) return win.self === win.top;
  try {
    return win.self !== win.top && win.parent === win.top
      && win.parent.location.origin === win.location.origin
      && typeof win.__MANTLE_ADMIN_PREVIEW__?.fetch === "function"
      && win.__MANTLE_ADMIN_PREVIEW__.fetch === win.fetch;
  } catch {
    return false;
  }
}

export const PREVIEW_CSP = "connect-src 'none'; form-action 'none'";

export function isAdminPreview(): boolean {
  return typeof document !== "undefined"
    && document.querySelector('meta[name="mantle-admin-preview"]')?.getAttribute("content") === "1";
}

/** Keep legacy host bridges from falling through to the live origin. */
export function installPreviewPolicy(win: Window): void {
  if (!canRenderAdmin(win, true)) throw new Error("Preview requires a same-origin sandbox bridge.");
  const bridge = win.fetch;
  const sandboxFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== win.location.origin || !url.pathname.startsWith("/admin/api/")) {
      throw new TypeError("This request is unavailable in the Admin preview.");
    }
    return bridge(request);
  };
  win.fetch = sandboxFetch;
  win.__MANTLE_ADMIN_PREVIEW__ = { fetch: sandboxFetch };
  // Enforce native fetch/XHR and form.submit(), which never enter our bridge.
  const policy = win.document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = PREVIEW_CSP;
  win.document.head.append(policy);
  win.document.addEventListener("submit", (event) => event.preventDefault(), true);
}
