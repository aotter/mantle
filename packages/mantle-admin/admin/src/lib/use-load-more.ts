import * as React from "react";

/**
 * What a "Load more" button owes assistive technology, for `count` rows shown and `loading` while any page is fetching:
 * when a fetch the button started finishes, announce the rows it added (`status`, for a polite live region), and if no
 * page follows and focus was left on the button (now gone) move it to `box`. A first page, a new filter or a new result
 * announces nothing and never takes focus.
 */
export function useLoadMore({ count, hasMore, loading, message }: { count: number; hasMore: boolean; loading: boolean; message: (added: number) => string }) {
  const box = React.useRef<HTMLDivElement>(null);
  const started = React.useRef<number | null>(null);
  const was = React.useRef(false);
  const [status, setStatus] = React.useState("");
  React.useEffect(() => {
    const done = was.current && !loading;
    was.current = loading;
    if (!done || started.current === null) return;
    const added = count - started.current;
    started.current = null;
    setStatus(added > 0 ? message(added) : "");
    const active = document.activeElement;
    if (!hasMore && (active === document.body || box.current?.contains(active))) box.current?.focus();
  }, [loading]);
  /** Call when the button is pressed. */
  const start = () => { started.current = count; };
  return { box, status, start };
}
