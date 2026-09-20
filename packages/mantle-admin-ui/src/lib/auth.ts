import { isAdminPreview } from "../app/frame-policy";

export function signOut(): void {
  if (isAdminPreview()) return;
  void fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  }).then(() => {
    window.location.href = "/admin/sign-in";
  });
}
