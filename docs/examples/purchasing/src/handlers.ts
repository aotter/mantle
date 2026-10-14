import { env } from "cloudflare:workers";
import { ContractError } from "@aotter/mantle/contracts";
import type { Handlers } from "../generated/generated.js";
import { emailOf, notify } from "./notify.js";

type Decided = { id: string; title: string; amount?: number; authorId: string };

export const handlers: Handlers = {
  "approve-request": async ({ db, store }, input) => {
    let decided: Decided;
    try {
      // One transaction: the guarded status change, the budget deduction and the ledger row.
      decided = (await store.procedures["approve-request-write"](input)).results[0]![0] as Decided;
    } catch (error) {
      // The declared budget check is a business refusal, not a server error. Nothing was written.
      if (String((error as Error)?.message).includes("MANTLE_CHECK budgets: remaining >= 0"))
        throw new ContractError("CONFLICT", "The department budget cannot cover this request.", "procedures/approve-request");
      throw error;
    }
    // After commit: place the supplier order. A failure leaves the request 'approved' for a retry.
    // AGENT: retry 'approved' requests (e.g. from the cron) and use the supplier's real API, auth and payload.
    let ordered = false;
    try {
      const response = await fetch(env.SUPPLIER_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": decided.id },
        body: JSON.stringify({ reference: decided.id, item: decided.title, amount: decided.amount }),
      });
      if (!response.ok) throw new Error(`supplier answered ${response.status}`);
      const { orderId } = await response.json() as { orderId: string };
      await store.procedures["mark-ordered"]({ id: decided.id, supplierOrderId: orderId });
      ordered = true;
    } catch (error) { console.error("[purchasing] supplier order failed; the request stays approved", error); }
    await notify(await emailOf(db, decided.authorId), `Approved: ${decided.title}`,
      `Your purchase request "${decided.title}" was approved${ordered ? " and ordered from the supplier" : ""}.`, "purchasing.approved");
    return { id: decided.id, requestStatus: ordered ? "ordered" : "approved" };
  },
  "reject-request": async ({ db, store }, input) => {
    const decided = (await store.procedures["reject-request-write"](input)).results[0]![0] as Decided;
    await notify(await emailOf(db, decided.authorId), `Rejected: ${decided.title}`,
      `Your purchase request "${decided.title}" was rejected.`, "purchasing.rejected");
    return { id: decided.id, requestStatus: "rejected" };
  },
};
