import type { Caller } from "@aotter/mantle/contracts";
import { store } from "../generated/generated.js";
import myRequests from "../generated/paged/views/my-requests.js";
import { handlers } from "./handlers.js";
import { signInRedirect } from "./sign-in.js";

/**
 * GET /requests: the employee's own page. Anonymous visitors go to /sign-in and come back.
 * Reads run here as the signed-in caller (`my-requests` restricts rows to `author_id = auth.uid()`). Writes do not:
 * the form submits to `POST /api/requests`, the REST Trigger the manifest declares for `submit-request`, so input
 * validation, `requires` and the origin check happen there. Request data never reaches a Procedure through app code.
 * AGENT: unstyled on purpose; add the app's styling, copy and a change-amount action (its own Trigger) as needed.
 */
export async function requestsPage(request: Request, env: Env, caller: Caller): Promise<Response> {
  if (caller.kind === "anonymous") return signInRedirect(request);
  const mine = await myRequests(env.DB, caller, {}, { limit: 50 });
  // Department names only; the budget amounts stay admin-side.
  const budgets = await store(env.DB, { kind: "system", reason: "department list" }, { handlers }).collection("budgets").find({ limit: 100 });
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>My purchase requests</title>
<h1>My purchase requests</h1>
<form action="/api/requests" method="post" id="new-request">
  <label>What <input name="title" required></label>
  <label>Amount <input name="amount" type="number" min="1" step="1" required></label>
  <label>Department <select name="department" required>${budgets.rows.map(b => `<option>${escape(String(b.department))}</option>`).join("")}</select></label>
  <button>Submit</button>
  <p role="alert" id="error" hidden></p>
</form>
<table>
  <tr><th>What</th><th>Amount</th><th>Department</th><th>Status</th></tr>
  ${mine.rows.map(r => `<tr><td>${escape(String(r.title))}</td><td>${escape(String(r.amount))}</td><td>${escape(String(r.department))}</td><td>${escape(String(r.requestStatus))}</td></tr>`).join("\n  ")}
</table>
<script type="module">
// The submit event fires only after the browser's own checks (required, min) pass; the Trigger checks again.
const form = document.getElementById("new-request"), error = document.getElementById("error");
form.addEventListener("submit", async event => {
  event.preventDefault();
  // Field types come from the inputs, so a number input sends a JSON number.
  const body = Object.fromEntries([...form.elements].filter(field => field.name).map(field => [field.name, field.type === "number" ? field.valueAsNumber : field.value]));
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch(form.action, { method: form.method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return location.reload(); // the page reads the list again
    error.textContent = (await response.json().catch(() => null))?.error?.message ?? "Not submitted. Try again.";
  } catch {
    error.textContent = "Not submitted: the network is unavailable.";
  }
  error.hidden = false;
  button.disabled = false;
});
</script>
`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
