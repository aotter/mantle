// The one script every visitor page loads (a module: it never blocks rendering), and through its import the one
// stylesheet, built beside it as page.css. A few hundred bytes without React. AGENT: keep React out of it.
// Each `data-island-src` element is server-rendered markup that works without JavaScript; its code, the content-hashed
// copy of src/client/<name>.tsx that the server names in the attribute, loads only when the element nears the viewport
// or is first used.
import "./page.css";

const loaded = new WeakSet<Element>(), clicked = new WeakSet<Element>();
const observer = new IntersectionObserver(entries => entries.forEach(entry => entry.isIntersecting && load(entry.target as HTMLElement)), { rootMargin: "200px" });
for (const element of document.querySelectorAll<HTMLElement>("[data-island-src]")) {
  observer.observe(element);
  // A click before the code arrived is replayed once the island has hydrated.
  element.addEventListener("click", () => (clicked.add(element), load(element)), { once: true });
}

function load(element: HTMLElement) {
  if (loaded.has(element)) return;
  loaded.add(element);
  observer.unobserve(element);
  // Only this site's own built files: an element naming anything else, or no URL at all, is ignored. A throw here would
  // stop the observer's loop and leave the other islands in its batch unloaded.
  let src: URL;
  try { src = new URL(element.dataset.islandSrc!, location.origin); } catch { return; }
  if (src.origin !== location.origin || !src.pathname.startsWith("/assets/client/")) return;
  // A computed URL: `mantle bundle` inlines a literal `import()` (one file per entry), which would bring React here.
  void import(/* @vite-ignore */ src.href).then(
    (island: { mount(element: HTMLElement, clicked: boolean): void }) => island.mount(element, clicked.has(element)),
    // A page opened before a deploy names the previous build's file, which is gone: reload once to get the new page. Only
    // when the file is confirmed missing (404); offline, a blocked request or an error in the island's code is not fixed
    // by a reload. The guard is per URL, so another island loading or failing never allows a second reload for this one.
    async () => {
      if (!navigator.onLine) return;
      const response = await fetch(src, { method: "HEAD", cache: "no-store" }).catch(() => undefined);
      if (response?.status !== 404) return;
      const key = `island-reloaded ${src.pathname}`;
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "1");
      } catch { return; } // no storage, no guard: no reload
      location.reload();
    },
  );
}
