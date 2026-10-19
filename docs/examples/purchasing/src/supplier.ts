import { env } from "cloudflare:workers";
import { ContractError } from "@aotter/mantle/contracts";
import type { HandlerContext } from "../generated/generated.js";

/**
 * Orders an approved request from the supplier, then marks it 'ordered'. Returns false when the supplier could not be
 * reached; the request stays 'approved' and the daily cron (src/schedule.ts) retries it.
 * AGENT: use the supplier's real API, auth and payload.
 */
export async function placeOrder(store: HandlerContext["store"], request: { id: string; title: string; amount: number }) {
  let orderId: string;
  try {
    const response = await fetch(env.SUPPLIER_API_URL, {
      method: "POST",
      // The request id as idempotency key: a retry after a lost response does not order twice.
      headers: { "content-type": "application/json", "idempotency-key": request.id },
      body: JSON.stringify({ reference: request.id, item: request.title, amount: request.amount }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`supplier answered ${response.status}`);
    ({ orderId } = await response.json() as { orderId: string });
  } catch (error) {
    console.error(`[purchasing] supplier order for ${request.id} failed; it stays approved for the retry`, error);
    return false;
  }
  try { await store.procedures["mark-ordered"]({ id: request.id, supplierOrderId: orderId }); }
  catch (error) {
    // The supplier's callback already confirmed it (it can arrive before this write).
    if (!(error instanceof ContractError && error.code === "CONFLICT")) throw error;
  }
  return true;
}
