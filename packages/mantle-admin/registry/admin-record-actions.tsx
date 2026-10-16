/**
 * Surface: both (the browser, and the Admin MCP App in an MCP host's sandboxed iframe).
 * Slots: record.actions:<schema>
 * Rules: read data only through @aotter/mantle-admin/hooks, link only with <AdminLink> or useOpenLink(), make no
 * network calls of your own, keep no auth in cookies or browser storage, open no windows, assume no width, load
 * nothing from a remote origin. Branch on `surface` if you must; both branches have to render.
 */
import { useState } from "react";
import { type RecordActionsProps, type SurfaceProp } from "@aotter/mantle-admin/app";
import { AdminUnavailableError, useOperation } from "@aotter/mantle-admin/hooks";

/** A button that runs the declared operation `approve` on this record. Rename the operation and shape its input. */
export function AdminRecordActions({ entry }: RecordActionsProps<object> & SurfaceProp) {
  const { run, pending } = useOperation("approve");
  const [message, setMessage] = useState<string>();
  // a surface that cannot write (an MCP host without server tools) shows nothing to press
  if (!run) return null;
  const press = () => {
    setMessage(undefined);
    run({ id: entry.id }).then(
      () => setMessage("Done"),
      (error: unknown) => setMessage(error instanceof AdminUnavailableError ? "Not available" : "Failed"),
    );
  };
  return (
    <>
      <button type="button" className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50" disabled={pending} onClick={press}>
        Approve
      </button>
      {message ? <span role="status" className="text-sm text-muted-foreground">{message}</span> : null}
    </>
  );
}
