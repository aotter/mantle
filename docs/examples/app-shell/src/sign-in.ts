/**
 * Member sign-in for app pages (Admin has its own at /admin/sign-in). Email one-time code through Better Auth's own
 * endpoints, then back to `?return=`. A member page calls `signInRedirect(request)` when `await caller()` is anonymous.
 * AGENT: unstyled on purpose; add the app's styling and copy. Delete this file and its route if the app has no
 * member pages.
 */
export function signInRedirect(request: Request): Response {
  const url = new URL(request.url);
  return new Response(null, { status: 303, headers: { location: `/sign-in?return=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
}

export function signInPage(): Response {
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in</title>
<h1>Sign in</h1>
<form id="email"><label>Email <input type="email" name="email" autocomplete="email" required></label> <button>Send code</button></form>
<form id="code" hidden><label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label> <button>Sign in</button></form>
<p id="status" role="status"></p>
<script type="module">
const status = document.getElementById("status"), email = document.getElementById("email"), code = document.getElementById("code");
// Only same-site paths: an open redirect would hand the fresh session's tab to another site.
const back = new URLSearchParams(location.search).get("return");
const target = back && new URL(back, location.origin).origin === location.origin ? back : "/";
const post = (path, body) => fetch("/api/auth" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
email.onsubmit = async event => {
  event.preventDefault();
  const response = await post("/email-otp/send-verification-otp", { email: email.email.value, type: "sign-in" });
  status.textContent = response.ok ? "We sent a code to your email." : "Could not send a code. Try again later.";
  code.hidden = !response.ok;
};
code.onsubmit = async event => {
  event.preventDefault();
  const response = await post("/sign-in/email-otp", { email: email.email.value, otp: code.otp.value });
  if (response.ok) location.assign(target);
  else status.textContent = response.status === 403 ? "This email cannot sign up here." : "Wrong or expired code.";
};
</script>
`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
