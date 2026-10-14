import { ContractError, type Caller } from "@aotter/mantle/contracts";
import { store } from "../generated/generated.js";
import submitRequest from "../generated/procedures/submit-request.js";
import { validate } from "../generated/validation/procedures/submit-request.js";
import myRequests from "../generated/paged/views/my-requests.js";
import { handlers } from "./handlers.js";
import { signInRedirect } from "./sign-in.js";

/**
 * GET/POST /requests: the employee's own page. Anonymous visitors go to /sign-in and come back. The form posts to
 * this page; the generated Procedure and View run as the signed-in caller, so `requires: ctx.user` and
 * `author_id = auth.uid()` decide what they may do and see, not this file.
 * AGENT: unstyled on purpose; add the app's styling, copy and a change-amount action as needed.
 */
export async function requestsPage(request: Request, env: Env, caller: Caller): Promise<Response> {
  if (caller.kind === "anonymous") return signInRedirect(request);
  let notice = "";
  if (request.method === "POST") {
    const form = await request.formData();
    try {
      // REST and MCP validate input before they call a Procedure; app code calling one directly validates it here.
      const input = { title: String(form.get("title") ?? ""), amount: Number(form.get("amount")), department: String(form.get("department") ?? "") };
      validate(input);
      await submitRequest(env.DB, caller, input);
      // Post/redirect/get: a reload does not submit twice.
      return new Response(null, { status: 303, headers: { location: "/requests" } });
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      notice = `Not submitted: ${error.message}`;
    }
  }
  const mine = await myRequests(env.DB, caller, {}, { limit: 50 });
  // Department names only; the budget amounts stay admin-side.
  const budgets = await store(env.DB, { kind: "system", reason: "department list" }, { handlers }).collection("budgets").find({ limit: 100 });
  return new Response(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>My purchase requests</title>
<h1>My purchase requests</h1>
${notice ? `<p role="alert">${escape(notice)}</p>` : ""}
<form method="post">
  <label>What <input name="title" required></label>
  <label>Amount <input name="amount" type="number" min="1" step="1" required></label>
  <label>Department <select name="department" required>${budgets.rows.map(b => `<option>${escape(String(b.department))}</option>`).join("")}</select></label>
  <button>Submit</button>
</form>
<table>
  <tr><th>What</th><th>Amount</th><th>Department</th><th>Status</th></tr>
  ${mine.rows.map(r => `<tr><td>${escape(String(r.title))}</td><td>${escape(String(r.amount))}</td><td>${escape(String(r.department))}</td><td>${escape(String(r.requestStatus))}</td></tr>`).join("\n  ")}
</table>
`, { status: notice ? 400 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
