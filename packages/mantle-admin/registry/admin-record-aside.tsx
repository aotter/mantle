import { type RecordAsideProps, type SurfaceProp } from "@aotter/mantle-admin/app";
import { useView } from "@aotter/mantle-admin/hooks";

/**
 * Surface: both (the browser, and the Admin MCP App in an MCP host's sandboxed iframe).
 * Slots: record.aside:<schema>
 * Rules: read data only through @aotter/mantle-admin/hooks, link only with <AdminLink> or useOpenLink(), make no
 * network calls of your own, keep no auth in cookies or browser storage, open no windows, assume no width, load
 * nothing from a remote origin. Branch on `surface` if you must; both branches have to render.
 */

/** A card beside the record listing the rows of the admin View `record-history` for this record. Rename the View and its input. */
export function AdminRecordAside({ entry }: RecordAsideProps<object> & SurfaceProp) {
  const history = useView("record-history", { id: entry.id }, { limit: 5 });
  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-2 text-sm font-semibold">History</h3>
      {history.status === "loading" ? <p className="text-sm text-muted-foreground">Loading</p> : null}
      {history.status === "unavailable" || history.status === "error" ? <p className="text-sm text-muted-foreground">Not available</p> : null}
      {history.status === "ready" && history.rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet</p> : null}
      <ul className="space-y-1 text-sm">
        {history.rows.map((row, index) => <li key={index} className="truncate">{String(Object.values(row)[0] ?? "")}</li>)}
      </ul>
    </section>
  );
}
