/** Browser-safe contract. The server projects it from its sealed RuntimePlan. */
export interface FrontendContract {
  readonly version: 1;
  readonly fingerprint: string;
  readonly views: readonly { name: string; inputSchema: unknown; outputSchema: unknown; requires?: unknown }[];
  readonly calls: readonly { name: string; procedure: string; method: string; path: string; inputSchema: unknown; outputSchema: unknown; requires?: unknown }[];
}

export class MantleClientError extends Error {
  constructor(readonly status: number, readonly diagnostic: unknown, readonly challenge: string | null) {
    super(`Mantle request failed (${status})`);
    this.name = "MantleClientError";
  }
}

export interface MantleClientOptions {
  readonly origin: string;
  readonly contract: FrontendContract;
  readonly fetch?: typeof fetch;
  /** Resolve for this request; do not share a user's client across SSR requests. */
  readonly accessToken?: () => string | undefined | Promise<string | undefined>;
}

export function createMantleClient(options: MantleClientOptions) {
  const origin = new URL(options.origin);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("Expected a backend origin");
  if (options.contract.version !== 1) throw new TypeError("Unsupported frontend contract");
  const views = new Map(options.contract.views.map(view => [view.name, view]));
  const calls = new Map(options.contract.calls.map(call => [call.name, call]));
  if (views.size !== options.contract.views.length || calls.size !== options.contract.calls.length) throw new TypeError("Duplicate frontend capability");
  for (const view of views.values()) if (!/^[\w-]+$/.test(view.name)) throw new TypeError("Invalid View name");
  for (const call of calls.values()) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(call.method)
      || !call.path.startsWith("/api/") || /[?#\\]/.test(call.path)
      || new URL(call.path, origin).pathname !== call.path.replaceAll("{", "%7B").replaceAll("}", "%7D")) throw new TypeError("Invalid HTTP Trigger route");
  }
  const request = async <T>(url: URL, init: RequestInit): Promise<T> => {
    init.signal?.throwIfAborted();
    const token = await options.accessToken?.();
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await (options.fetch ?? globalThis.fetch)(new Request(url, { ...init, headers, credentials: token ? "omit" : "same-origin", redirect: "error" }));
    let body: { ok?: boolean; data?: T; diagnostic?: unknown };
    try { body = await response.json() as typeof body; }
    catch { throw new MantleClientError(response.status, null, response.headers.get("www-authenticate")); }
    if (!response.ok || body?.ok !== true) throw new MantleClientError(response.status, body?.diagnostic ?? null, response.headers.get("www-authenticate"));
    return body.data as T;
  };
  return {
    view<T = unknown>(name: string, params: Record<string, unknown> = {}, paging: { page?: number; show?: number; signal?: AbortSignal } = {}): Promise<T> {
      if (!views.has(name)) throw new TypeError("Unknown public View");
      const url = new URL(`/api/views/${name}`, origin);
      for (const [key, value] of Object.entries({ ...params, ...(paging.page === undefined ? {} : { page: paging.page }), ...(paging.show === undefined ? {} : { show: paging.show }) })) {
        if (value !== undefined) url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      return request<T>(url, { signal: paging.signal });
    },
    /** Invoke the named HTTP Trigger, retaining its Procedure's authorization. */
    call<T = unknown>(name: string, input: Record<string, unknown>, settings: { signal?: AbortSignal } = {}): Promise<T> {
      const call = calls.get(name);
      if (!call) throw new TypeError("Unknown HTTP Trigger");
      const path = call.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
        const value = input[key];
        if (typeof value !== "string" && typeof value !== "number") throw new TypeError(`Missing route parameter ${key}`);
        const encoded = encodeURIComponent(String(value));
        if (!encoded || encoded === "." || encoded === "..") throw new TypeError("Invalid route parameter");
        return encoded;
      });
      return request<T>(new URL(path, origin), { method: call.method, headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: settings.signal });
    },
  };
}
