// The one script every visitor page loads (a module: it never blocks rendering), and through its import the one
// stylesheet, built beside it as /assets/client/page.css. A few hundred bytes without React. AGENT: keep React out of it.
// Each `data-island="<name>"` element is server-rendered markup that works without JavaScript; its code,
// /assets/client/<name>.js (src/client/<name>.tsx), loads only when the element nears the viewport or is first used.
import "./page.css";

const loaded = new WeakSet<Element>(), clicked = new WeakSet<Element>();
const observer = new IntersectionObserver(entries => entries.forEach(entry => entry.isIntersecting && load(entry.target as HTMLElement)), { rootMargin: "200px" });
for (const element of document.querySelectorAll<HTMLElement>("[data-island]")) {
  observer.observe(element);
  // A click before the code arrived is replayed once the island has hydrated.
  element.addEventListener("click", () => (clicked.add(element), load(element)), { once: true });
}

function load(element: HTMLElement) {
  if (loaded.has(element)) return;
  loaded.add(element);
  observer.unobserve(element);
  // A computed URL: `mantle bundle` inlines a literal `import()` (one file per entry), which would bring React here.
  const src = `/assets/client/${element.dataset.island}.js`;
  void import(/* @vite-ignore */ src).then((island: { mount(element: HTMLElement, clicked: boolean): void }) => island.mount(element, clicked.has(element)));
}
