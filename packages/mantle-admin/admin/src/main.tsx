import { canRenderAdmin, installPreviewPolicy, isAdminPreview } from "./app/frame-policy";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { loadLanguage } from "./app/i18n";
import { MantleAdmin } from "./app/mantle-admin";
import { readInitialLanguage } from "./app/preferences";
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
  // The locale loads before first paint; <MantleAdmin> reads the same stored or browser choice.
  void loadLanguage(readInitialLanguage())
    .catch(error => console.error("Admin language could not be loaded", error))
    .then(() => ReactDOM.createRoot(rootElement).render(
      <StrictMode>
        <MantleAdmin admin={admin} preview={preview} />
      </StrictMode>,
    ));
}
