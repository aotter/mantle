import { canRenderAdmin, installPreviewPolicy, isAdminPreview } from "./app/frame-policy";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { AdminRoot } from "./app/admin-root";
import admin from "./default-entry";
import "./styles/global.css";
import { installExtensionShared } from "./app/extension-shared";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element.");
}

installExtensionShared();

const preview = isAdminPreview();
if (preview && canRenderAdmin(window, true)) installPreviewPolicy(window);
if (canRenderAdmin(window, preview)) {
  ReactDOM.createRoot(rootElement).render(
    <StrictMode>
      <AdminRoot admin={admin} preview={preview} />
    </StrictMode>,
  );
}
