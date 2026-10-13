import type { EntryEditorPayload } from "./types";

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

/** RFC 4180 cells; strings that spreadsheets execute are treated as text. */
export function csvCell(value: unknown, quote = false): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safe = typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r]/u.test(text) ? `'${text}` : text;
  return quote || /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Client exports read ordinary authorized pages; a failed page creates no partial download. */
export async function downloadAdminFile(path: string, declaredColumns?: readonly string[]): Promise<void> {
  const url = new URL(path, window.location.href);
  const entry = url.pathname === `${BASE}/entries/export`;
  const view = url.pathname.match(/^\/admin\/api\/views\/([^/]+)\/export$/);
  if (url.origin !== window.location.origin || (!entry && !view)) throw new TypeError("Expected an Admin download URL.");
  if (entry && !declaredColumns) throw new TypeError("Entry export columns must come from collection metadata.");
  const query = new URLSearchParams(url.search);
  query.delete("cursor");
  query.delete("cursor_direction");
  query.set("limit", "500");
  const endpoint = entry ? "/entries" : `/views/${view![1]}`;
  const chunks: string[] = [];
  const seen = new Set<string>();
  let columns = declaredColumns;
  for (;;) {
    const page = await api.get<{ items?: { data: Record<string, unknown>; id: string; status: string | null; version: number | string; updated_at: number }[]; rows?: Record<string, unknown>[]; next_cursor?: string | null; nextCursor?: string }>(`${endpoint}?${query}`);
    const rows: Record<string, unknown>[] = entry ? page.items!.map(({ data, id, status, version, updated_at }) => ({ ...data, id, status, version, updated_at })) : page.rows!;
    if (!columns) columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
    if (!chunks.length) chunks.push("\uFEFF" + columns.map(column => csvCell(column)).join(",") + "\r\n");
    chunks.push(rows.map(row => columns!.map(column => csvCell(row[column])).join(",") + "\r\n").join(""));
    const cursor = entry ? page.next_cursor : page.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw new Error("Export paging did not advance.");
    seen.add(cursor);
    query.set("cursor", cursor);
  }
  const objectUrl = URL.createObjectURL(new Blob(chunks, { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${entry ? query.get("collection") : decodeURIComponent(view![1]!)}.csv`;
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
