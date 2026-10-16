import { useState } from "react";
import { type RecordActionsProps } from "@aotter/mantle-admin/app";
import { AdminUnavailableError, useOperation } from "@aotter/mantle-admin/hooks";

/**
 * Surface: browser (the record page; never an MCP Procedure action form).
 * Slots: record.actions:<schema>
 * Server authorization still applies to reads and writes; replacing this component grants nothing.
 */

/** A button that runs the declared operation `approve` on this record. Rename the operation and shape its input. */
export function AdminRecordActions({ entry }: RecordActionsProps<object>) {
  const { run, pending } = useOperation("approve");
  const [message, setMessage] = useState<string>();
  const press = () => {
    if (!run) return;
    setMessage(undefined);
    run({ id: entry.id }).then(
      () => setMessage("Done"),
      (error: unknown) => setMessage(error instanceof AdminUnavailableError ? "Not available" : "Failed"),
    );
  };
  return (
    <>
      <button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50" disabled={pending || !run} onClick={press}>
        Approve
      </button>
      {/* an unavailable host transport disables the button; the server still authorizes each invocation */}
      {!run ? <span className="text-sm text-muted-foreground">Read-only here</span> : null}
      {message ? <span role="status" className="text-sm text-muted-foreground">{message}</span> : null}
    </>
  );
}
