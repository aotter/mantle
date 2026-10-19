import { isAdminPreview } from "../app/frame-policy";

/** The Better Auth instance Admin signs in with: `adminShell(..., { authBasePath })` names a non-default one. */
export const AUTH_BASE = (typeof document === "undefined" ? null : document.querySelector<HTMLMetaElement>('meta[name="mantle-auth-base"]')?.content) || "/api/auth";

export function signOut(): void {
  if (isAdminPreview()) return;
  void fetch(`${AUTH_BASE}/sign-out`, {
    method: "POST",
    credentials: "include",
  }).then(() => {
    window.location.href = "/admin/sign-in";
  });
}
