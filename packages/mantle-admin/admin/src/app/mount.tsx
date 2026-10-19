import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { AdminRoot } from "./admin-root";
import type { AdminDefinition } from "./define-admin";
import { canRenderAdmin, installPreviewPolicy, isAdminPreview } from "./frame-policy";

/**
 * Internal: what `@aotter/mantle-admin/build`'s page runs. It renders an entry's `defineAdmin(...)` into `#root` under
 * the canonical frame refusal, or as the same-origin preview after installing the preview policy.
 */
export function mountAdmin(admin: AdminDefinition): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element.");
  const preview = isAdminPreview();
  if (preview && canRenderAdmin(window, true)) installPreviewPolicy(window);
  if (canRenderAdmin(window, preview)) {
    ReactDOM.createRoot(rootElement).render(
      <StrictMode>
        <AdminRoot admin={admin} preview={preview} />
      </StrictMode>,
    );
  }
}
