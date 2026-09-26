import { canRenderAdmin, installPreviewPolicy, isAdminPreview } from "./app/frame-policy";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AdminApp } from "./app/admin-app";
import { PreferencesProvider } from "./app/preferences";
import { queryClient } from "./app/query-client";
import { AdminRouterProvider } from "./app/router";
import { ConfirmProvider } from "./ui/confirm-dialog";
import { TooltipProvider } from "@aotter/mantle-ui/kit";
import { Toaster } from "@aotter/mantle-ui/kit";
import { usePreferences } from "./app/preferences";
import "./styles/global.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element.");
}

const preview = isAdminPreview();
if (preview && canRenderAdmin(window, true)) installPreviewPolicy(window);
if (canRenderAdmin(window, preview)) ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
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
  </StrictMode>,
);

function AdminToaster(): React.ReactElement {
  const { theme } = usePreferences();
  return <Toaster theme={theme} position="bottom-right" />;
}
