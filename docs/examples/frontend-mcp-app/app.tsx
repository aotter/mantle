import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { EntityPreview } from "@aotter/mantle-ui";

interface Rows { rows: { id: string; title: string; version: number }[]; nextCursor?: string }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function readRows(result: { isError?: boolean; structuredContent?: unknown; content: readonly { type: string; text?: string }[] }): Rows {
  if (result.isError) throw new Error("Unable to read tasks");
  const output: unknown = result.structuredContent ?? JSON.parse(result.content.find(block => block.type === "text")?.text ?? "");
  if (!record(output) || !Array.isArray(output.rows) || (output.nextCursor != null && (typeof output.nextCursor !== "string" || !output.nextCursor))) throw new Error("Invalid task result");
  const rows = output.rows.map((row: unknown) => {
    if (!record(row) || typeof row.id !== "string" || typeof row.title !== "string" || typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error("Invalid task row");
    return { id: row.id, title: row.title, version: row.version };
  });
  return { rows, ...(typeof output.nextCursor === "string" ? { nextCursor: output.nextCursor } : {}) };
}
function Frontend() {
  const generation = useRef(0);
  const [page, setPage] = useState<Rows>({ rows: [] });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { app, isConnected, error } = useApp({
    appInfo: { name: "my-tasks", version: "1" }, capabilities: {},
    onAppCreated: app => { app.ontoolresult = result => {
      // This application consumes its declared View result, not Admin metadata.
      generation.current++;
      try { setPage(readRows(result)); setFailure(null); }
      catch { setFailure("Unable to read tasks. Ask for the task list again."); }
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
      const next = readRows(result);
      if (opened !== generation.current) return;
      setPage(current => ({ rows: [...current.rows, ...next.rows], ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}) }));
    } catch { if (opened === generation.current) setFailure("Unable to load more tasks"); }
    finally { setBusy(false); }
  };
  return <main aria-busy={busy}><h1>My tasks</h1>{page.rows.map(row => <EntityPreview key={row.id} entry={{ id: row.id, version: row.version, data: { title: row.title } }} />)}
    {page.nextCursor && app?.getHostCapabilities()?.serverTools ? <button disabled={busy} onClick={() => { void more(); }}>Load more</button> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Frontend />);
