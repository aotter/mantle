import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { invalidateAfterWrite } from "../lib/after-write";

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    // The one refresh after an Admin write. `meta: { invalidates: false }` skips it: a download changes nothing, and
    // `useOperation` refreshes on its own client. A caller that also invalidates here would refetch twice.
    onSuccess: (_data, _variables, _context, mutation): void => { if (mutation.meta?.["invalidates"] !== false) void invalidateAfterWrite(queryClient); },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && [401, 403, 501].includes(error.status)) {
          return false;
        }
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

for (const key of ["collections", "views-manifest", "operations"]) {
  queryClient.setQueryDefaults([key], { staleTime: Infinity });
}

for (const key of ["me", "site", "admin-webmcp"]) {
  queryClient.setQueryDefaults([key], { staleTime: 300_000, refetchOnWindowFocus: true });
}

queryClient.setQueryDefaults(["entries"], { staleTime: 300_000 });

// nav badges: fresh for 30 s, read again when the window regains focus, never polled
queryClient.setQueryDefaults(["badges"], { staleTime: 30_000, refetchOnWindowFocus: true });
