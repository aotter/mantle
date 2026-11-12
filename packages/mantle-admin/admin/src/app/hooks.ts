import * as React from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type { AdminBadge, AdminTypes } from "./define-admin";
import { useAdminContext } from "./hooks-context";
import { MAX_BADGE_VIEWS, createMcpAppTransport } from "./transport";
import { invalidateAfterWrite, type ViewRefresh } from "../lib/after-write";

export { useOpenLink } from "./slots";

/** Where Admin renders: its own page, or inside an MCP host (`ui://`). Slots and hooks that work in both say so. */
export type AdminSurface = "browser" | "mcp-app";

/** `unavailable` is a refused or a missing target, on purpose indistinguishable; it is also what a surface without the data reads as. */
export type ReadStatus = "loading" | "ready" | "unavailable" | "error";

/** A transport's answer: the data, or `unavailable` for a 403 or 404 (an MCP tool's `AUTH_DENIED` or `NOT_FOUND`). */
export type Reply<T> = { readonly status: "ok"; readonly data: T } | { readonly status: "unavailable" };

type Row = Readonly<Record<string, unknown>>;

/** An entry as `/admin/api/entries` returns it; `data` is typed by the generated collection. */
export interface AdminEntry<Data> {
  readonly id: string;
  readonly collection: string;
  readonly locale: string | null;
  readonly status: "draft" | "published" | "archived" | null;
  readonly version: number | string;
  readonly data: Data;
  readonly created_at?: number | null;
  readonly updated_at: number;
}

/** The signed-in caller, as `/admin/api/me` returns it. */
export interface AdminMe {
  readonly userId: string;
  readonly role: string | null;
  readonly admin: boolean;
  readonly login: string | null;
  readonly image: string | null;
}

/**
 * What became of a request the person may confirm in the host (`sendMessage`). `accepted`: the host answered without an
 * error, which is not proof of delivery (a host can answer before the person agrees). `refused`: the host answered with
 * an error, does not offer the request, or it was not sent. `unknown`: no answer came (a timeout, a lost connection, an
 * error thrown on the way); the host may still act on it, so do not report a failure or invite a resend.
 */
export type HostRequestOutcome = "accepted" | "refused" | "unknown";

/** What an MCP host lets Admin do beyond rendering. Each is sent only when the host advertised it. */
export interface AdminHost {
  /** The host's context: theme, locale, time zone, safe area and the rest. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly capabilities: Readonly<Record<string, unknown>>;
  /**
   * `ui/open-link`: an http(s) URL in the user's browser. False when the host cannot or refuses, or did not answer in
   * time (a link the person confirms late can still open).
   */
  openLink(url: string): Promise<boolean>;
  /**
   * `ui/message`: a user message in the conversation, which the person may confirm in the host first. Kept within what
   * Claude accepts: invisible characters such as soft hyphens and zero-width spaces are dropped, and runs of more than
   * three line breaks or 64 spaces or tabs shortened; a blank text, or one over 8,000 characters after that, is `refused`
   * without asking the host.
   */
  sendMessage(text: string): Promise<HostRequestOutcome>;
  /** `ui/update-model-context`: what the model should know at its next turn. */
  updateModelContext(params: {
    readonly content?: readonly { readonly type: "text"; readonly text: string }[];
    readonly structuredContent?: Readonly<Record<string, unknown>>;
  }): Promise<boolean>;
  /**
   * `ui/request-display-mode`: the mode the host set. A refusal resolves with the current mode, so compare the answer
   * with the mode asked for; null when the host does not list `mode` in `context.availableDisplayModes` or no valid answer
   * came. Call it directly in a click or key handler while the App has focus (do not cancel the button's `mousedown`):
   * Claude refuses `fullscreen` without a recent click or key press in the view. Claude reports `fullscreen` in its side
   * panel too, so label a way back "back to the conversation", not "exit full screen".
   */
  requestDisplayMode(mode: "inline" | "fullscreen" | "pip"): Promise<"inline" | "fullscreen" | "pip" | null>;
  /**
   * `ui/download-file`: a text file saved to the person's device after they confirm it in the host. `name` is the saved
   * file's name with its extension (`report.csv`); spaces stay, and `/`, `?`, `#`, `\`, `%`, `:`, `"`, `*`, `<`, `>`, `|`
   * and `~` become `_`. `mimeType` defaults to `text/plain`. `refused` when the host offers no downloads
   * (`capabilities.downloadFile`), refuses, or the person cancels, or `name` is empty, `.` or `..`; `unknown` when no
   * answer came, and the host's dialog may still save the file. Send one at a time, when the person asks for it.
   */
  downloadFile(name: string, text: string, mimeType?: string): Promise<HostRequestOutcome>;
  /**
   * The page's own app tools, which a host may let the model call while the App is open, listed by name after the App's
   * built-in `view_*` tools. The page and any component it renders may each register; the returned function
   * removes only these tools, and aborts their calls still running, so return it from the `useEffect` that registers them.
   * Throws, adding nothing, on a definition a host would reject: a name outside `[A-Za-z0-9._-]{1,128}`, starting `view_`,
   * or already registered; an `inputSchema` whose root type is not `object`, over 64 KiB or nested over 32 levels; more
   * than 64 tools or 1 MiB of definitions with the built-in ones and those registered. The host learns of each change of
   * definitions (`notifications/tools/list_changed`); registering the same definitions again sends nothing.
   */
  registerTools(tools: readonly AdminAppTool[]): () => void;
}

/**
 * An app tool a page registers (`AdminHost.registerTools`). It runs the page's own code in the App; what it does on the
 * server goes through the page's hooks, under the caller's authorization. Keep the definition constant: a host may ask the
 * person to approve a tool again when its name, title, description or input schema changes.
 */
export interface AdminAppTool {
  /** Letters, digits, `.`, `_` and `-`, up to 128; `view_` is the App's own. */
  readonly name: string;
  /** What a host's approval prompt names; the name when absent. */
  readonly title?: string;
  /** What the tool does; a host may show the model only the first line. */
  readonly description: string;
  /** Plain JSON Schema with `type: "object"` at the root. The App does not check arguments against it: the handler does. */
  readonly inputSchema: { readonly type: "object"; readonly [keyword: string]: unknown };
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  /**
   * Runs a call: the text the model reads. A throw is an error result carrying its message, but a host may not pass the
   * message to the model, so for a mistake the model can fix return a normal answer that says what to change. `signal`
   * aborts when the host cancels or the tool is removed. Answer within the host's time limit (Claude: 45 seconds): start
   * longer work and report it from another tool.
   */
  handler(args: Readonly<Record<string, unknown>>, signal: AbortSignal): string | Promise<string>;
}

/** One View in a badge batch. */
export type BadgeAnswer = { readonly rows: readonly Row[] } | { readonly unavailable: true } | { readonly error: true };

/** A badge as the sidebar shows it: loading, a count (zero included), unavailable (shows nothing) or error. */
export interface BadgeState {
  readonly count: number | undefined;
  readonly status: ReadStatus;
}

/** An MCP tool result, as a host returns it. */
export interface McpToolResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

/** A read's `signal`, from the query that asked for it. */
export interface ReadOptions {
  readonly signal?: AbortSignal | undefined;
}

/** How a surface reads and writes: `/admin/api` in the browser, `tools/call` through an MCP host. The hooks do not know which. */
export interface AdminTransport {
  readonly surface: AdminSurface;
  /** The host's API; null in the browser. */
  readonly host: AdminHost | null;
  /** Whether this surface can write: an MCP host without server tools is read-only. */
  readonly writable: boolean;
  /** Each read takes the query's `signal`: a cancelled refetch (a newer write's, an unmount) stops its request where the surface can. */
  view(
    name: string,
    input: Row,
    page: {
      readonly limit?: number | undefined;
      readonly cursor?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    },
    rowNames?: { readonly [column: string]: string },
  ): Promise<Reply<{ readonly rows: readonly Row[]; readonly nextCursor?: string }>>;
  entries(
    collection: string,
    options: {
      readonly filter?: { readonly field: string; readonly value: string } | undefined;
      readonly search?: string | undefined;
      readonly limit?: number | undefined;
      readonly cursor?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<Reply<{ readonly items: readonly AdminEntry<Row>[]; readonly nextCursor?: string }>>;
  entry(collection: string, id: string, read?: ReadOptions): Promise<Reply<AdminEntry<Row>>>;
  total(collection: string, read?: ReadOptions): Promise<Reply<number>>;
  me(read?: ReadOptions): Promise<Reply<AdminMe>>;
  /** One read of up to `MAX_BADGE_VIEWS` Views' first rows, each as the caller: a refused or missing View is `unavailable`, one that could not answer is `error`. */
  badges(names: readonly string[], read?: ReadOptions): Promise<Reply<{ readonly [name: string]: BadgeAnswer }>>;
  run(name: string, input: Row): Promise<Reply<unknown>>;
}

/** An MCP App's transport: Views and operations through `call` (the host's `tools/call`); everything else is `unavailable`. */
export interface McpAppTransportOptions {
  /** The host's server tool call; leave it out when the host did not advertise `serverTools`, and the App is read-only. */
  readonly call?: ((tool: string, args: Record<string, unknown>) => Promise<McpToolResult>) | undefined;
  readonly host: AdminHost;
}

/** `run` of a refused or missing operation rejects with this: the caller cannot tell which. */
export class AdminUnavailableError extends Error {
  constructor() {
    super("Unavailable.");
    this.name = "AdminUnavailableError";
  }
}

export interface ViewOptions {
  /** The size of each page; `loadMore()` appends the next one. */
  readonly limit?: number;
}
export interface EntriesOptions<Data> {
  /** One field equal to one value, as the entries route filters. */
  readonly filter?: { readonly field: keyof Data & string; readonly value: string };
  readonly search?: string;
  /** The size of each page; `loadMore()` appends the next one. */
  readonly limit?: number;
}
/** The pages loaded so far, in order, and how to load the next. Changing the input starts again from the first page. */
export interface LoadMoreState {
  /** Another page follows the ones loaded. */
  readonly hasMore: boolean;
  /** Loads and appends the next page. Does nothing when `hasMore` is false, or while any fetch is in flight, a refetch after a write included: that one is not cancelled. */
  readonly loadMore: () => void;
  /** The next page, which this hook's `loadMore()` fetches, is loading; the rows already loaded stay. */
  readonly loadingMore: boolean;
}
export interface ViewState<R> extends LoadMoreState {
  readonly rows: readonly R[];
  /** `error` after a failed `loadMore()` too: the rows already loaded stay, and `loadMore()` retries. */
  readonly status: ReadStatus;
}
export interface EntriesState<Data> extends LoadMoreState {
  readonly items: readonly AdminEntry<Data>[];
  /** `error` after a failed `loadMore()` too: the items already loaded stay, and `loadMore()` retries. */
  readonly status: ReadStatus;
}
export interface EntryState<Data> {
  readonly entry: AdminEntry<Data> | undefined;
  readonly status: ReadStatus;
}
export interface TotalState {
  readonly total: number | undefined;
  readonly status: ReadStatus;
}
export interface MeState {
  readonly me: AdminMe | undefined;
  readonly status: ReadStatus;
}
/** A View `useOperation` reads again after a success: by name (every input), or one `useView` input of it. */
export type OperationRefresh<T extends AdminTypes> = {
  readonly [N in keyof T["views"] & string]: N | { readonly view: N; readonly input: T["views"][N]["input"] };
}[keyof T["views"] & string];
export interface OperationOptions<T extends AdminTypes> {
  /**
   * Read only these Views again after a success, instead of every View (#1794). Other Views are marked stale and read again
   * when next shown; entries, open entries, totals and badges refresh as always. Leave it out to refresh every View.
   */
  readonly refresh?: readonly OperationRefresh<T>[];
}
export interface OperationState<I, O> {
  /** Undefined where the surface cannot write. Rejects with `AdminUnavailableError` when refused or missing. */
  readonly run: ((input: I) => Promise<O>) | undefined;
  readonly pending: boolean;
}

/**
 * Admin's data hooks, typed by the application's generated `AdminTypes`; `generated/admin-client.ts` exports them bound.
 * Every hook reads only the caller-authorized `/admin/api` routes in the browser (or an MCP tool in a host) and shares
 * Admin's query cache. None takes a caller, a role or a system flag; a refusal reads as `unavailable`.
 *
 * Surface: `useView` and `useOperation` are `both`. `useEntries`, `useEntry`, `useCollectionTotal` and `useMe` are
 * `browser` and read `unavailable` in an MCP host: declare the data an App needs as an admin View.
 */
export interface AdminHooks<T extends AdminTypes> {
  /** `GET /admin/api/views/{name}`, or the View's admin MCP tool in a host. All pages loaded so far, appended in order: `loadMore()` fetches the next. */
  useView<N extends keyof T["views"] & string>(
    name: N,
    input: T["views"][N]["input"],
    options?: ViewOptions,
  ): ViewState<T["views"][N]["row"]>;
  /** `GET /admin/api/entries`, appended page by page like `useView`. Browser only. */
  useEntries<N extends keyof T["collections"] & string>(
    collection: N,
    options?: EntriesOptions<T["collections"][N]["data"]>,
  ): EntriesState<T["collections"][N]["data"]>;
  /** `GET /admin/api/entries/{id}`. Browser only. */
  useEntry<N extends keyof T["collections"] & string>(
    collection: N,
    id: string,
  ): EntryState<T["collections"][N]["data"]>;
  /**
   * `POST /admin/api/operations/{name}`, or the operation's admin MCP tool in a host. A success refreshes Views, entries and
   * totals, once; `refresh` narrows the Views read again to the ones named.
   */
  useOperation<N extends keyof T["operations"] & string>(
    name: N,
    options?: OperationOptions<T>,
  ): OperationState<T["operations"][N]["input"], T["operations"][N]["output"]>;
  /** The `total` of `GET /admin/api/collections/{name}/statistics`. Browser only. */
  useCollectionTotal(collection: keyof T["collections"] & string): TotalState;
  /** `GET /admin/api/me`. Browser only. */
  useMe(): MeState;
  /**
   * The counts of `refs` in one `GET /admin/api/view-batch`, in the order given: each is `field` of the first row of an aggregate
   * admin View, run as the caller. Cached 30 s, refreshed on window focus and after a mutation, never polled; keyed by the signed-in
   * user. Reads `unavailable` in an MCP host. Reads only the first `MAX_BADGE_VIEWS` distinct Views.
   */
  useBadges(refs: readonly AdminBadge<T>[]): readonly BadgeState[];
}

const statusOf = (query: { isPending: boolean; isError: boolean }, reply: Reply<unknown> | undefined): ReadStatus =>
  query.isError ? "error" : query.isPending ? "loading" : reply?.status === "unavailable" ? "unavailable" : "ready";

/** The accumulating state of an infinite query over a transport's `Reply` pages. */
function useAccumulated<Page extends { readonly nextCursor?: string }, Item>(
  query: UseInfiniteQueryResult<InfiniteData<Reply<Page>>>,
  pick: (page: Page) => readonly Item[],
) {
  const first = query.data?.pages[0];
  const list = React.useMemo(
    () => (query.data?.pages ?? []).flatMap(reply => (reply.status === "ok" ? pick(reply.data) : [])),
    [query.data],
  );
  return {
    list,
    status: statusOf(query, first),
    hasMore: query.hasNextPage,
    // a refetch in flight (after a write) is not cancelled for the next page
    loadMore: () => {
      if (query.hasNextPage && !query.isFetching) void query.fetchNextPage({ cancelRefetch: false });
    },
    loadingMore: query.isFetchingNextPage,
  };
}
const nextPage = (reply: Reply<{ readonly nextCursor?: string }>): string | undefined =>
  reply.status === "ok" ? reply.data.nextCursor : undefined;

const implementation = {
  useView(name: string, input: object, options: ViewOptions = {}): ViewState<object> {
    const { meta, transport } = useAdminContext();
    const rowNames = meta.rowNames?.[name];
    const query = useInfiniteQuery({
      queryKey: ["view", name, "hook", transport.surface, input, options.limit],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        transport.view(name, input as Row, { limit: options.limit, cursor: pageParam }, rowNames),
      getNextPageParam: nextPage,
    });
    const { list, ...state } = useAccumulated(query, page => page.rows);
    return { rows: list, ...state };
  },
  useEntries(collection: string, options: EntriesOptions<object> = {}): EntriesState<object> {
    const { transport } = useAdminContext();
    const query = useInfiniteQuery({
      queryKey: ["entries", collection, "hook", transport.surface, options],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) => transport.entries(collection, { ...options, cursor: pageParam }),
      getNextPageParam: nextPage,
    });
    const { list, ...state } = useAccumulated(query, page => page.items);
    return { items: list, ...state };
  },
  useEntry(collection: string, id: string): EntryState<object> {
    const { transport } = useAdminContext();
    const query = useQuery({
      queryKey: ["entry-editor", collection, id, "hook", transport.surface],
      queryFn: () => transport.entry(collection, id),
    });
    return { entry: query.data?.status === "ok" ? query.data.data : undefined, status: statusOf(query, query.data) };
  },
  useOperation(
    name: string,
    options: { readonly refresh?: readonly ViewRefresh[] } = {},
  ): OperationState<object, unknown> {
    const { transport } = useAdminContext();
    const client = useQueryClient();
    const { refresh } = options;
    const mutation = useMutation({
      mutationFn: async (input: object): Promise<unknown> => {
        const reply = await transport.run(name, input as Row);
        if (reply.status === "unavailable") throw new AdminUnavailableError();
        return reply.data;
      },
      // the shared cache: what Admin shows and what the application's own components read both refetch. The hook
      // refreshes on whichever client it runs under (an MCP App's has no global handler), so Admin's global
      // `MutationCache` handler skips it: one refetch per write, not a second one cancelling the first.
      onSuccess: () => {
        void invalidateAfterWrite(client, refresh);
      },
      meta: { invalidates: false },
    });
    return { run: transport.writable ? mutation.mutateAsync : undefined, pending: mutation.isPending };
  },
  useCollectionTotal(collection: string): TotalState {
    const { transport } = useAdminContext();
    const query = useQuery({
      queryKey: ["collection-statistics", collection, "total", transport.surface],
      queryFn: () => transport.total(collection),
    });
    return { total: query.data?.status === "ok" ? query.data.data : undefined, status: statusOf(query, query.data) };
  },
  useMe(): MeState {
    const { transport } = useAdminContext();
    const query = useQuery({ queryKey: ["me", "hook", transport.surface], queryFn: () => transport.me() });
    return { me: query.data?.status === "ok" ? query.data.data : undefined, status: statusOf(query, query.data) };
  },
  useBadges(refs: readonly { readonly view: string; readonly field: string }[]): readonly BadgeState[] {
    const { transport } = useAdminContext();
    const me = useQuery({ queryKey: ["me", "hook", transport.surface], queryFn: () => transport.me() });
    const names = [...new Set(refs.map(ref => ref.view))].slice(0, MAX_BADGE_VIEWS);
    // the user is in the key: another identity never reads this one's counts
    const userId = me.data?.status === "ok" ? me.data.data.userId : undefined;
    const query = useQuery({
      queryKey: ["badges", userId, transport.surface, names],
      queryFn: () => transport.badges(names),
      enabled: names.length > 0 && userId !== undefined,
    });
    return refs.map((ref): BadgeState => {
      if (!names.includes(ref.view)) return { count: undefined, status: "unavailable" };
      if (me.isError || query.isError) return { count: undefined, status: "error" };
      if (me.isPending || query.isPending || userId === undefined)
        return { count: undefined, status: me.data?.status === "unavailable" ? "unavailable" : "loading" };
      const answer = query.data?.status === "ok" ? query.data.data[ref.view] : undefined;
      if (!answer || "unavailable" in answer) return { count: undefined, status: "unavailable" };
      const count = "rows" in answer ? (answer.rows.length ? Number(answer.rows[0]![ref.field]) : 0) : NaN;
      return Number.isFinite(count) ? { count, status: "ready" } : { count: undefined, status: "error" };
    });
  },
};

/** The hooks typed by `T`; the types are all that differs, so every call returns the same functions. */
export function createAdminHooks<T extends AdminTypes = AdminTypes>(): AdminHooks<T> {
  return implementation as unknown as AdminHooks<T>;
}

/** Untyped hooks for code that has no generated types, such as a component ejected from the default Admin. */
export const useView: AdminHooks<AdminTypes>["useView"] = implementation.useView as AdminHooks<AdminTypes>["useView"];
export const useEntries: AdminHooks<AdminTypes>["useEntries"] =
  implementation.useEntries as AdminHooks<AdminTypes>["useEntries"];
export const useEntry: AdminHooks<AdminTypes>["useEntry"] =
  implementation.useEntry as AdminHooks<AdminTypes>["useEntry"];
export const useOperation: AdminHooks<AdminTypes>["useOperation"] =
  implementation.useOperation as AdminHooks<AdminTypes>["useOperation"];
export const useCollectionTotal: AdminHooks<AdminTypes>["useCollectionTotal"] = implementation.useCollectionTotal;
export const useMe: AdminHooks<AdminTypes>["useMe"] = implementation.useMe;
export const useBadges: AdminHooks<AdminTypes>["useBadges"] = implementation.useBadges;

/** The MCP host's API, or null in the browser. Handle the null: a component that renders in both surfaces must work in both. */
export function useHost(): AdminHost | null {
  return useAdminContext().transport.host;
}

/** Where this component renders. Branching on it is allowed; both branches must render. */
export function useAdminSurface(): AdminSurface {
  return useAdminContext().transport.surface;
}

/** The transport for an MCP App; `@aotter/mantle-admin/hooks` is the only place an App's `tools/call` is wired. */
export const mcpAppTransport: (options: McpAppTransportOptions) => AdminTransport = createMcpAppTransport;
