/** How long after a reload a second chunk failure is left to surface instead of reloading again. */
const RELOAD_WINDOW_MS = 10_000;
const KEY = "mantle-admin:stale-chunk-reload";

/**
 * After a deploy the previous build's content-hashed chunks are gone, so an open tab that imports one gets a 404.
 * Vite reports it as `vite:preloadError`; reload once so the page loads the new build. A failure again within
 * RELOAD_WINDOW_MS (the chunk is really missing, or storage is unavailable) is left to surface, so it never loops.
 */
export function reloadOnStaleChunk(win: Window, now: () => number = Date.now): void {
  win.addEventListener("vite:preloadError", (event) => {
    let last = 0;
    try {
      last = Number(win.sessionStorage.getItem(KEY)) || 0;
      if (now() - last < RELOAD_WINDOW_MS) return;
      win.sessionStorage.setItem(KEY, String(now()));
    } catch { return; }
    event.preventDefault();
    win.location.reload();
  });
}
