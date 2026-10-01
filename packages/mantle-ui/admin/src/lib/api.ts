import { isAdminPreview } from "../app/frame-policy";

const BASE = "/admin/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    throw new ApiError(`${res.status} ${res.statusText}`, res.status, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> =>
    request<T>(path, options.signal ? { signal: options.signal } : undefined),
  post: <T>(path: string, body?: unknown, options: { signal?: AbortSignal } = {}): Promise<T> =>
    request<T>(path, { ...jsonInit("POST", body), ...(options.signal ? { signal: options.signal } : {}) }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, jsonInit("PATCH", body)),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
};

/** Preview downloads use its bridge; live exports retain browser streaming. */
export async function downloadAdminFile(path: string): Promise<void> {
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith(`${BASE}/`)) {
    throw new TypeError("Expected an Admin download URL.");
  }
  if (!isAdminPreview()) {
    window.location.assign(url.href);
    return;
  }
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new ApiError(`${response.status} ${response.statusText}`, response.status, await response.text());
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = /filename="([^"]+)"/i.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "export.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
