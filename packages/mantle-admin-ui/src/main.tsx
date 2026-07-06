import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AdminApp } from "./app/admin-app";
import { PreferencesProvider } from "./app/preferences";
import { queryClient } from "./app/query-client";
import { AdminRouterProvider } from "./app/router";
import { ConfirmProvider } from "./ui/confirm-dialog";
import { ToastProvider } from "./ui/toast";
import "./styles/index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element.");
}

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider>
        <AdminRouterProvider>
          <ToastProvider>
            <ConfirmProvider>
              <AdminApp />
            </ConfirmProvider>
          </ToastProvider>
        </AdminRouterProvider>
      </PreferencesProvider>
    </QueryClientProvider>
  </StrictMode>,
);
