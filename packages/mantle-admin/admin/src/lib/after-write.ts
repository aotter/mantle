import { hashKey, type Query, type QueryClient } from "@tanstack/react-query";

/** Everything an Admin write can change: lists, counts, open entries, Views and nav badges. */
const AFFECTED = ["view", "entries", "entry-editor", "collection-statistics", "badges"] as const;

/** A View to read again after a write: every input of it, or the one `useView` reads with this `input`. */
export type ViewRefresh = string | { readonly view: string; readonly input: object };

/** `useView`'s key is `["view", name, "hook", surface, input, limit]`; Admin's own View page is `["view", name, search]`. */
const matches = (query: Query, refresh: Exclude<ViewRefresh, string>): boolean => {
  const key = query.queryKey;
  return key[0] === "view" && key[1] === refresh.view && key[2] === "hook" && hashKey([key[4]]) === hashKey([refresh.input]);
};

/**
 * Read these again after any Admin write; resolves once the shown ones have refetched (a failed read does not reject).
 * `views` narrows only the Views read again now (#1794): the others are marked stale without a refetch, so they read again
 * when next shown, while entries, open entries, totals and badges refresh as always, since a write can change any collection.
 */
export const invalidateAfterWrite = async (client: QueryClient, views?: readonly ViewRefresh[]): Promise<void> => {
  if (!views) {
    await Promise.all(AFFECTED.map((key) => client.invalidateQueries({ queryKey: [key] })));
    return;
  }
  void client.invalidateQueries({ queryKey: ["view"], refetchType: "none" });
  await Promise.all([
    ...AFFECTED.filter((key) => key !== "view").map((key) => client.invalidateQueries({ queryKey: [key] })),
    ...views.map((view) => client.invalidateQueries(typeof view === "string" ? { queryKey: ["view", view] } : { predicate: (query) => matches(query, view) })),
  ]);
};
