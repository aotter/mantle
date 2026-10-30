import { ApiError, api } from "../lib/api";
import { isRecord, ok, unavailable } from "./transport";
import type { AdminEntry, AdminMe, BadgeAnswer, AdminTransport, Reply } from "./hooks";

type Row = Readonly<Record<string, unknown>>;

/** A 403 or 404 reads as unavailable, so the front end cannot tell a refusal from absence. `also` adds statuses a route uses to say "not here". */
async function read<T>(fetch: () => Promise<T>, also: readonly number[] = []): Promise<Reply<T>> {
  try {
    return ok(await fetch());
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404 || also.includes(error.status))) return unavailable;
    throw error;
  }
}

const path = (name: string): string => encodeURIComponent(name);
/** The query's signal for `api.get`: a cancelled refetch aborts its request. */
const signalOf = (options: { readonly signal?: AbortSignal | undefined } | undefined): { signal?: AbortSignal } => options?.signal ? { signal: options.signal } : {};

/** The browser: the caller-authorized `/admin/api` routes, with the Admin session cookie. No route is added for the hooks. */
export const browserTransport: AdminTransport = {
  surface: "browser",
  host: null,
  writable: true,
  view: (name, input, page) => read(() => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...input, limit: page.limit, cursor: page.cursor })) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const suffix = query.toString();
    return api.get<{ rows: Row[]; nextCursor?: string }>(`/views/${path(name)}${suffix ? `?${suffix}` : ""}`, signalOf(page));
  }),
  entries: (collection, options) => read(async () => {
    const query = new URLSearchParams({ collection });
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.search) query.set("search", options.search);
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.filter) { query.set("filter_field", options.filter.field); query.set("filter_value", options.filter.value); }
    const page = await api.get<{ items: AdminEntry<Row>[]; next_cursor: string | null }>(`/entries?${query}`, signalOf(options));
    return { items: page.items, ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}) };
  }),
  // a caller the policy refuses to read the Schema gets a stub with no `data`: that is a refusal, not an entry
  entry: async (collection, id, options) => {
    const reply = await read(async () => (await api.get<{ entry: AdminEntry<Row> }>(`/entries/${path(id)}?collection=${path(collection)}`, signalOf(options))).entry);
    return reply.status === "ok" && !isRecord(reply.data.data) ? unavailable : reply;
  },
  // a collection without statistics answers 501 whatever the caller: it has no total to show
  total: (collection, options) => read(async () => (await api.get<{ total: number }>(`/collections/${path(collection)}/statistics?range=7d`, signalOf(options))).total, [501]),
  me: options => read(() => api.get<AdminMe>("/me", signalOf(options))),
  badges: (names, options) => read(async () => (await api.get<{ views: { [name: string]: BadgeAnswer } }>(`/view-batch?names=${encodeURIComponent(names.join(","))}`, signalOf(options))).views),
  run: (name, input) => read(async () => (await api.post<{ ok: boolean; output: unknown }>(`/operations/${path(name)}`, input)).output),
};
