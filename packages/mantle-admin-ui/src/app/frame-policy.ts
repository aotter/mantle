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
