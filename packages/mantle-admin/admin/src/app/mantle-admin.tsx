import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster, TooltipProvider } from "@aotter/mantle-ui/kit";
import { ConfirmProvider } from "../ui/confirm-dialog";
import { AdminApp } from "./admin-app";
import type { AdminDefinition } from "./define-admin";
import { PreferencesProvider, readInitialLanguage, usePreferences } from "./preferences";
import { queryClient } from "./query-client";
import { AdminRouterProvider } from "./router";

export interface MantleAdminProps {
  /** The entry's `defineAdmin(...)` result. */
  admin: AdminDefinition;
  /** Render inside the same-origin design preview. */
  preview?: boolean;
}

/**
 * Admin's root: its query cache, preferences, router and dialogs around the routed views, for an app that mounts it
 * itself. The language is the stored or browser choice; strings not yet loaded for it fall back to English.
 */
export function MantleAdmin({ preview = false }: MantleAdminProps): React.ReactElement {
  const [initialLanguage] = React.useState(readInitialLanguage);
  return (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider initialLanguage={initialLanguage}>
        <AdminRouterProvider>
          <TooltipProvider>
            <ConfirmProvider>
              <AdminApp preview={preview} />
              <AdminToaster />
            </ConfirmProvider>
          </TooltipProvider>
        </AdminRouterProvider>
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

function AdminToaster(): React.ReactElement {
  const { theme } = usePreferences();
  return <Toaster theme={theme} position="bottom-right" />;
}
