import type * as React from "react";
import { AdminRoot } from "./admin-root";
import type { AdminDefinition } from "./define-admin";

export interface MantleAdminProps {
  /** The entry's `defineAdmin(...)` result. */
  admin: AdminDefinition;
}

/**
 * Admin's root: its query cache, preferences, router and dialogs around the routed views, for an app that mounts it
 * itself. It renders once the stored or browser language has loaded.
 */
export function MantleAdmin({ admin }: MantleAdminProps): React.ReactElement {
  return <AdminRoot admin={admin} />;
}
