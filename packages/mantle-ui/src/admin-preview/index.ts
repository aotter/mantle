/** Static document preparation and the explicit preview protocol, independent of Admin's application internals. */
export function adminPreviewDocument(html: string, options: { assetBasePath: string; basePath: string; design?: boolean }): string {
  for (const path of [options.assetBasePath, options.basePath]) if (path.startsWith("//") || !/^\/[a-zA-Z0-9/_-]+$/.test(path)) throw new TypeError("Expected a local preview mount path.");
  if (!html.includes('name="mantle-admin-preview"')) throw new TypeError("Expected the SDK's opt-in preview document.");
  const assets = options.assetBasePath.replace(/\/$/, "");
  return html.replace(/<base\s+href=["']\/admin\/["']\s*\/?>/, `<base href="${assets}/">`).replace(/(\b(?:src|href)=["'])\/admin\//g, `$1${assets}/`)
    .replace("<head>", `<head><script src="${assets}/host-bridge.js" data-base-path="${options.basePath}" data-mode="${options.design ? "design" : "runtime"}"></script>`);
}

export function readAdminPreviewRequest(value: unknown, origin: string): Request {
  const data = value as { type?: unknown; protocolVersion?: unknown; request?: { url?: unknown; method?: unknown; headers?: unknown; body?: unknown } } | null;
  const input = data?.request;
  if (data?.type !== "mantle:host-api:request" || data.protocolVersion !== 1 || !input || typeof input.url !== "string" ||
    typeof input.method !== "string" || !["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(input.method) ||
    !Array.isArray(input.headers) || !input.headers.every(header => Array.isArray(header) && header.length === 2 && header.every(part => typeof part === "string")) ||
    !(input.body === null || input.body instanceof ArrayBuffer) || (input.body && input.body.byteLength > 1024 * 1024)) throw new TypeError("Invalid Admin preview request.");
  const url = new URL(input.url);
  if (url.origin !== origin || !url.pathname.startsWith("/admin/api/") || (["GET", "HEAD"].includes(input.method) && input.body !== null)) throw new TypeError("Unsupported Admin preview request.");
  return new Request(url, { method: input.method, headers: input.headers, ...(input.body ? { body: input.body } : {}) });
}

/** Host-owned commands rendered by the opt-in preview, never inferred by Admin. */
export interface AdminPreviewMenu {
  label: string;
  description: string;
  items: { id: string; label: string; disabled?: boolean }[];
}
export function readAdminPreviewMenu(value: unknown): AdminPreviewMenu {
  const menu = value as AdminPreviewMenu | null;
  const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
  if (!menu || !text(menu.label, 80) || !text(menu.description, 240) || !Array.isArray(menu.items) || menu.items.length > 32 ||
    menu.items.some(item => !item || !text(item.id, 80) || !/^[a-zA-Z0-9:_-]+$/.test(item.id) || !text(item.label, 80) || (item.disabled !== undefined && typeof item.disabled !== "boolean")) ||
    new Set(menu.items.map(item => item.id)).size !== menu.items.length) throw new TypeError("Invalid Admin preview menu.");
  return menu;
}
export function readAdminPreviewAction(value: unknown): string {
  const data = value as { type?: unknown; protocolVersion?: unknown; id?: unknown } | null;
  if (data?.type !== "mantle:host-ui:action" || data.protocolVersion !== 1 || typeof data.id !== "string" || !/^[a-zA-Z0-9:_-]{1,80}$/.test(data.id)) throw new TypeError("Invalid Admin preview action.");
  return data.id;
}
