import { api } from "./api";
import type { StaffOperation } from "./types";

/**
 * Shared react-query options for `GET /admin/api/operations` (#426,
 * extended #430 with `title`/`rowBindings`). Extracted once a third
 * call site needed the exact same `{ queryKey, queryFn }` pair
 * (`authenticated-layout.tsx`, `operations-view.tsx`,
 * `collection-view.tsx`) — same query key (`["operations"]`) as
 * before, so react-query still dedupes/caches across all three.
 */
export function operationsQueryOptions(): {
  queryKey: readonly ["operations"];
  queryFn: () => Promise<StaffOperation[]>;
} {
  return {
    queryKey: ["operations"] as const,
    queryFn: async () => {
      const res = await api.get<{ operations: StaffOperation[] }>("/operations");
      return res.operations;
    },
  };
}
