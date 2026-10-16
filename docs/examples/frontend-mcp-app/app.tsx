import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { EntityPreview } from "@aotter/mantle-ui";

interface Rows { rows: { id: string; title: string; version: number }[]; nextCursor?: string }
function Frontend() {
  const generation = useRef(0);
  const [page, setPage] = useState<Rows>({ rows: [] });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { app, isConnected, error } = useApp({
    appInfo: { name: "my-tasks", version: "1" }, capabilities: {},
    onAppCreated: app => { app.ontoolresult = result => {
      // This application consumes its declared View result, not Admin metadata.
      if (result.isError) { setFailure("Unable to read tasks"); return; }
      generation.current++;
      setPage(result.structuredContent as unknown as Rows);
    }; },
  });
  if (error || failure) return <p role="alert">{error?.message ?? failure}</p>;
  if (!isConnected) return <p>Connecting…</p>;
  const more = async () => {
    if (!app || busy || !page.nextCursor) return;
    const opened = generation.current;
    setBusy(true);
    try {
      const result = await app.callServerTool({ name: "my_tasks", arguments: { limit: 1, cursor: page.nextCursor } });
      if (result.isError) throw new Error("Unable to load more tasks");
      const next = result.structuredContent as unknown as Rows;
      if (opened !== generation.current) return;
      setPage(current => ({ rows: [...current.rows, ...next.rows], ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}) }));
    } catch { if (opened === generation.current) setFailure("Unable to load more tasks"); }
    finally { setBusy(false); }
  };
  return <main><h1>My tasks</h1>{page.rows.map(row => <EntityPreview key={row.id} entry={{ id: row.id, version: row.version, data: { title: row.title } }} />)}
    {page.nextCursor && app?.getHostCapabilities()?.serverTools ? <button disabled={busy} onClick={() => { void more(); }}>Load more</button> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Frontend />);
