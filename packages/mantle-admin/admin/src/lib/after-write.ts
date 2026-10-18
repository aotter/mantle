import type { QueryClient } from "@tanstack/react-query";

/** Everything an Admin write can change: lists, counts, open entries, Views and nav badges. */
const AFFECTED = ["view", "entries", "entry-editor", "collection-statistics", "badges"] as const;

/** Read these again after any Admin write; resolves once the shown ones have refetched (a failed read does not reject). */
export const invalidateAfterWrite = async (client: QueryClient): Promise<void> => {
  await Promise.all(AFFECTED.map((key) => client.invalidateQueries({ queryKey: [key] })));
};
