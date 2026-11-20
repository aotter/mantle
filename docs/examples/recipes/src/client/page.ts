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

// Set before the one reload below and cleared once an island loads, so a page whose island keeps failing is not reloaded again.
const RELOADED = "island-reloaded";

function load(element: HTMLElement) {
  if (loaded.has(element)) return;
  loaded.add(element);
  observer.unobserve(element);
  // A computed URL: `mantle bundle` inlines a literal `import()` (one file per entry), which would bring React here.
  void import(/* @vite-ignore */ element.dataset.islandSrc!).then(
    (island: { mount(element: HTMLElement, clicked: boolean): void }) => {
      island.mount(element, clicked.has(element));
      try { sessionStorage.removeItem(RELOADED); } catch {}
    },
    // A page opened before a deploy names the previous build's file, which is gone: reload once to get the new page.
    () => {
      try {
        if (sessionStorage.getItem(RELOADED)) return;
        sessionStorage.setItem(RELOADED, "1");
      } catch { return; } // no storage, no guard: no reload
      location.reload();
    },
  );
}
