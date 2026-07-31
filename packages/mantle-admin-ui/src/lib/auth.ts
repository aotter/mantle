export function signOut(): void {
  void fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
  }).then(() => {
    window.location.href = "/admin/sign-in";
  });
}
