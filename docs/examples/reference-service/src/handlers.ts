import { ContractError, type Caller } from "@aotter/mantle/contracts";
import { store, type Handlers } from "../generated/generated.js";

/** The old after hook was post-commit, best effort, and ran with the actual caller. */
export async function recordOrders(db: Parameters<typeof store>[0], caller: Caller, rows: readonly Record<string, unknown>[], kind: "after_create" | "after_update") {
  try {
    const data = store(db, caller, { handlers });
    await data.batch(rows.map(row => data.collection("activity").insert({
      kind, subject: String(row.id), detail: `${String(row.orderStatus ?? row.orderstatus)} x${String(row.qty)}`,
    })));
  } catch { console.error("[reference] order activity failed after commit"); }
}
export const handlers: Handlers = {
  "place-order": async ({ db, caller, store: data }, input) => {
    // The declared stock check refuses an oversell as a CONFLICT naming the check.
    const output = await data.procedures["place-order-write"](input);
    await recordOrders(db, caller, output.results[0]!, "after_create");
    return output;
  },
  "cancel-order": async ({ db, caller }, { orderId, expectedVersion }) => {
    const data = store(db, caller, { handlers });
    const orders = data.collection("orders"), items = data.collection("items");
    const order = await orders.first({ where: { id: orderId, orderstatus: "placed" } });
    const item = order ? await items.findById(order.itemid) : null;
    if (!order || !item) throw new ContractError("CONFLICT", "The order is not visible or placed.", "procedures/cancel-order");
    await data.batch([
      orders.update(orderId, { orderstatus: "cancelled" }, { lock: expectedVersion }),
      items.update(item.id, { stock: item.stock + order.qty }, { lock: item.version }),
    ]);
    await recordOrders(db, caller, [{ ...order, orderstatus: "cancelled" }], "after_update");
    return { id: orderId, orderStatus: "cancelled" };
  },
};

/** Application cron: one bounded cursor walk, never a generated schedule Trigger. */
export async function weeklyDigest(db: D1Database, scheduledTime: number) {
  const caller: Caller = { kind: "system", reason: "weekly order digest" };
  const data = store(db, caller, { handlers });
  let cursor: string | undefined, count = 0, units = 0;
  for (let pages = 0; pages < 20; pages++) {
    const page = await data.collection("orders").find({ where: { orderstatus: "placed" }, limit: 500, cursor });
    count += page.rows.length;
    units += page.rows.reduce((sum, row) => sum + row.qty, 0);
    cursor = page.cursor ?? undefined;
    if (!cursor) break;
  }
  // ponytail: at most 10,000 orders per run; persist a continuation for larger digests.
  if (cursor) throw new Error("Digest exceeds 20 pages; retain a continuation before recording a complete digest.");
  await data.collection("activity").insert({ kind: "weekly-digest", subject: String(scheduledTime), detail: `${count} orders, ${units} units` });
}
