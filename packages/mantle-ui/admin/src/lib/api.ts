import type { EntryEditorPayload } from "./types";
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

/** The server's refusal in a response body: Admin's routes answer `{ error }`, an operation's result `{ diagnostic }`. */
export function refusalOf(body: unknown): { code?: string; message?: string } | undefined {
  const b = body as { error?: { code?: string; message?: string }; diagnostic?: { code?: string; message?: string } } | null;
  return b?.error ?? b?.diagnostic ?? undefined;
}

const statusLine = (res: Response, body: unknown) => refusalOf(body)?.message || `${res.status} ${res.statusText}`;

async function request<T>(path: string, init?: RequestInit, input?: unknown): Promise<T> {
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
    // the server's refusal says what is wrong; the status line is the fallback
    const error = new ApiError(statusLine(res, body), res.status, body);
    const code = refusalOf(body)?.code;
    const entry = path.match(/^(\/entries\/[^/?]+)(?:\/(?:publish|unpublish|archive))?(\?[^#]*)?$/);
    if (init?.method && entry && (code === "CONFLICT" || code === "OUTCOME_UNKNOWN")) {
      try {
        const latest = await request<EntryEditorPayload>(entry[1]! + (entry[2] ?? ""), {signal:AbortSignal.timeout(10_000)});
        const expected = (input as {expectedVersion?: unknown} | undefined)?.expectedVersion;
        error.message += code === "OUTCOME_UNKNOWN"
          ? " The latest entry was read; the write outcome is still unconfirmed. Review it before trying again."
          : expected !== undefined && latest.entry.version !== expected
          ? ` The current version is v${latest.entry.version}. Reload and review your changes before trying again.`
          : " The latest entry was read; the write conditions no longer match. Review its current state before trying again.";
      } catch {
        error.message += " The latest entry could not be read. Refresh before trying again.";
      }
    }
    throw error;
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> =>
    request<T>(path, options.signal ? { signal: options.signal } : undefined),
  post: <T>(path: string, body?: unknown, options: { signal?: AbortSignal } = {}): Promise<T> =>
    request<T>(path, { ...jsonInit("POST", body), ...(options.signal ? { signal: options.signal } : {}) }, body),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, jsonInit("PATCH", body), body),
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
  if (!response.ok) {
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* not JSON: the status line explains it */ }
    throw new ApiError(statusLine(response, body), response.status, body);
  }
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
