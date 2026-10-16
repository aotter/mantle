import { type RecordAsideProps } from "@aotter/mantle-admin/app";
import { useView } from "@aotter/mantle-admin/hooks";

/**
 * Surface: browser (the record page; never an MCP Procedure action form).
 * Slots: record.aside:<schema>
 * Server authorization still applies to reads and writes; replacing this component grants nothing.
 */

/** A card beside the record listing the rows of the admin View `record-history` for this record. Rename the View and its input. */
export function AdminRecordAside({ entry }: RecordAsideProps<object>) {
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
