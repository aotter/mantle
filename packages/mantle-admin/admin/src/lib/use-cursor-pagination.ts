import * as React from "react";

interface CursorPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export function useCursorPagination<T>(
  page: CursorPage<T> | null | undefined,
  options: {
    resetKey: string;
    resetOnPageChange: boolean;
    loadPage: (cursor: string) => Promise<CursorPage<T>>;
  },
) {
  const [extraItems, setExtraItems] = React.useState<T[]>([]);
  const [loadedCursor, setLoadedCursor] = React.useState<string | null | undefined>();
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [loadMoreError, setLoadMoreError] = React.useState<unknown>(null);
  const pageReset = options.resetOnPageChange ? page : null;

  React.useEffect(() => {
    setExtraItems([]);
    setLoadedCursor(undefined);
    setLoadMoreError(null);
  }, [options.resetKey, pageReset]);

  const nextCursor = loadedCursor !== undefined ? loadedCursor : page?.next_cursor ?? null;
  const items = React.useMemo(() => [...(page?.items ?? []), ...extraItems], [page, extraItems]);

  const loadMore = React.useCallback(async () => {
    if (!nextCursor) return;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const nextPage = await options.loadPage(nextCursor);
      setExtraItems((current) => [...current, ...nextPage.items]);
      setLoadedCursor(nextPage.next_cursor);
    } catch (error) {
      setLoadMoreError(error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, options.loadPage]);

  return { items, nextCursor, isLoadingMore, loadMoreError, loadMore };
}
