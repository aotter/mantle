import * as React from "react";
import type { AdminMeta } from "./define-admin";
import type { AdminTransport } from "./hooks";

interface AdminHooksValue {
  readonly meta: AdminMeta;
  readonly transport: AdminTransport;
}

const AdminHooksContext = React.createContext<AdminHooksValue | null>(null);

/** Internal: what the data hooks read. `<MantleAdmin>` provides the browser transport; an MCP App entry provides its own. */
export function AdminHooksProvider(props: React.PropsWithChildren<AdminHooksValue>): React.ReactElement {
  const { meta, transport } = props;
  const value = React.useMemo(() => ({ meta, transport }), [meta, transport]);
  return <AdminHooksContext.Provider value={value}>{props.children}</AdminHooksContext.Provider>;
}

export function useAdminContext(): AdminHooksValue {
  const value = React.useContext(AdminHooksContext);
  if (!value) throw new Error("Admin hooks run inside <MantleAdmin>.");
  return value;
}
