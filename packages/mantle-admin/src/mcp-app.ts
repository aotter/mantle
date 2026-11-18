import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

/** `McpUiStyleVariableKey`: the colors, fonts, radii, borders and shadows a host may set. */
const HOST_STYLE_VARIABLE =
  /^--(color-(background|text|border|ring)-[a-z]+|font-(sans|mono|weight-[a-z]+|(text|heading)-[a-z0-9]+-(size|line-height))|border-radius-[a-z]+|border-width-regular|shadow-[a-z]+)$/;

/**
 * The host's presentation fields on the document root. A fixed height (`fullscreen`: the side panel or full screen) bounds
 * the root, which scrolls inside it. In the conversation the host gives only `maxHeight`: it caps the frame and clips what
 * exceeds it, and on a touch screen a vertical pan scrolls the conversation, so the root is not a scroll container there and
 * its content sets the height it reports. `scroll` bounds it by `maxHeight` and scrolls it all the same: wherever the App
 * does not fit the conversation, in another display mode or when the host offers no full screen or refused it.
 */
export function applyHostContext(
  value: McpUiHostContext,
  doc: Document = document,
  { scroll = false }: { readonly scroll?: boolean } = {},
): void {
  const root = doc.documentElement;
  if (value.locale) root.lang = value.locale;
  // `.dark` too, so an application's `.dark {}` overrides apply in a host as in the browser
  if (value.theme) {
    root.dataset.theme = value.theme;
    root.style.colorScheme = value.theme;
    root.classList.toggle("dark", value.theme === "dark");
  }
  // only the spec's style variables: a host cannot reach the App's own tokens (its primary color)
  for (const [key, item] of Object.entries(value.styles?.variables ?? {}))
    if (typeof item === "string" && HOST_STYLE_VARIABLE.test(key)) root.style.setProperty(key, item);
  const insets = value.safeAreaInsets,
    box = value.containerDimensions as
      | Partial<Record<"height" | "maxHeight" | "width" | "maxWidth", number>>
      | undefined;
  if (insets) {
    root.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
    for (const side of ["top", "right", "bottom", "left"] as const)
      root.style.setProperty(`--mantle-safe-${side}`, `${insets[side]}px`);
  }
  if (box) {
    root.style.height = box.height === undefined ? "" : `${box.height}px`;
    // the host's width is an upper bound; the frame's own width wins when the host reports a wider one (#1931)
    for (const key of ["width", "maxWidth"] as const)
      root.style[key] = box[key] === undefined ? "" : `min(${box[key]}px, 100%)`;
    // a bounded frame scrolls its content; the max-height also holds the measured size within a fixed height
    const bound =
      box.height !== undefined || scroll ? Math.min(box.height ?? Infinity, box.maxHeight ?? Infinity) : Infinity;
    root.style.maxHeight = bound === Infinity ? "" : `${bound}px`;
    root.style.overflow = bound === Infinity ? "" : "auto";
  }
  const fonts = value.styles?.css?.fonts;
  if (fonts !== undefined) {
    const style =
      doc.getElementById("mantle-host-fonts") ??
      doc.head.appendChild(Object.assign(doc.createElement("style"), { id: "mantle-host-fonts" }));
    style.textContent = fonts;
  }
}
