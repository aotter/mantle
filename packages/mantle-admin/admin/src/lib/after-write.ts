import type { QueryClient } from "@tanstack/react-query";

/** Everything an Admin write can change: lists, counts, open entries, Views and nav badges. */
const AFFECTED = ["view", "entries", "entry-editor", "collection-statistics", "badges"] as const;

/** Read these again after any Admin write. */
export const invalidateAfterWrite = (client: QueryClient): void => {
  for (const key of AFFECTED) void client.invalidateQueries({ queryKey: [key] });
};
