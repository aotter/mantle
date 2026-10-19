import * as React from "react";
import type { AdminMeta } from "./define-admin";
import type { AdminTransport } from "./hooks";
import { SurfaceProvider, type AdminLayers } from "./slots";

interface AdminHooksValue {
  readonly meta: AdminMeta;
  readonly transport: AdminTransport;
}

interface AdminHooksProps extends AdminHooksValue {
  /** The application's slot components (`AdminDefinition.layers`). */
  readonly layers?: AdminLayers;
}

const NO_LAYERS: AdminLayers = {};
const AdminHooksContext = React.createContext<AdminHooksValue | null>(null);

/** Internal: what the data hooks read. `<MantleAdmin>` provides the browser transport; an MCP App entry provides its own. */
export function AdminHooksProvider(props: React.PropsWithChildren<AdminHooksProps>): React.ReactElement {
  const { meta, transport, layers = NO_LAYERS } = props;
  const value = React.useMemo(() => ({ meta, transport }), [meta, transport]);
  return (
    <AdminHooksContext.Provider value={value}>
      <SurfaceProvider surface={transport.surface} host={transport.host} layers={layers}>{props.children}</SurfaceProvider>
    </AdminHooksContext.Provider>
  );
}

export function useAdminContext(): AdminHooksValue {
  const value = React.useContext(AdminHooksContext);
  if (!value) throw new Error("Admin hooks run inside <MantleAdmin>.");
  return value;
}
