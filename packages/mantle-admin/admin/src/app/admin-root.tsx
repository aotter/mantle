import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster, TooltipProvider } from "@aotter/mantle-ui/kit";
import { ConfirmProvider } from "../ui/confirm-dialog";
import { AdminApp } from "./admin-app";
import { AdminHooksProvider } from "./hooks-context";
import { loadLanguage, STRINGS } from "./i18n";
import { PreferencesProvider, readInitialLanguage, usePreferences, type AdminLanguage } from "./preferences";
import { queryClient } from "./query-client";
import { AdminRouterProvider } from "./router";
import { browserTransport } from "./transport";
import type { AdminDefinition } from "./define-admin";

/**
 * Admin's provider tree around the routed views. Internal: `preview` is set only by the canonical preview document,
 * after it has installed the preview policy (`installPreviewPolicy`); the public `<MantleAdmin>` never sets it.
 */
export function AdminRoot(props: { admin: AdminDefinition; preview?: boolean }): React.ReactElement {
  const [initialLanguage] = React.useState(readInitialLanguage);
  // Nothing paints until the stored or browser language has loaded; a failed load falls back to English.
  return (
    <React.Suspense fallback={null}>
      <LanguageGate language={initialLanguage}>
        <QueryClientProvider client={queryClient}>
          <PreferencesProvider initialLanguage={initialLanguage}>
            <AdminRouterProvider>
              <AdminHooksProvider meta={props.admin.meta} transport={browserTransport}>
                <TooltipProvider>
                  <ConfirmProvider>
                    <AdminApp preview={props.preview ?? false} />
                    <AdminToaster />
                  </ConfirmProvider>
                </TooltipProvider>
              </AdminHooksProvider>
            </AdminRouterProvider>
          </PreferencesProvider>
        </QueryClientProvider>
      </LanguageGate>
    </React.Suspense>
  );
}

const languageLoads = new Map<AdminLanguage, Promise<void>>();

function LanguageGate({ language, children }: React.PropsWithChildren<{ language: AdminLanguage }>): React.ReactNode {
  if (language === "en" || STRINGS[language]) return children;
  let load = languageLoads.get(language);
  if (!load) {
    load = loadLanguage(language).catch(error => console.error("Admin language could not be loaded", error));
    languageLoads.set(language, load);
  }
  React.use(load);
  return children;
}

function AdminToaster(): React.ReactElement {
  const { theme } = usePreferences();
  return <Toaster theme={theme} position="bottom-right" />;
}
