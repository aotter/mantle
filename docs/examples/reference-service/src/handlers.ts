// Written once by `mantle generate`, then filled in. `MantleHandlers` lists exactly the plan's handler refs.
import type { MantleHandlers } from "../.mantle/generated/mantle.js";

export const handlers: MantleHandlers = {
  // ctx.store is scoped to the caller: another owner's order is not visible, so the write below is a CONFLICT, never a leak
  cancelOrder: async ({ orderId, expectedVersion }, ctx) => {
    const [order] = (await ctx.store.select({ from: "orders", where: { id: orderId, orderStatus: "placed" } })).rows;
    const [item] = order ? (await ctx.store.select({ from: "items", where: { id: String(order.itemId) } })).rows : [];
    await ctx.store.write([
      { update: "orders", set: { orderStatus: "cancelled" }, where: { id: orderId }, lock: expectedVersion },
      // both rows or neither: the stock goes back only with the cancellation, and a concurrent restock is a CONFLICT
      ...(order && item ? [{ update: "items" as const, set: { stock: Number(item.stock) + Number(order.qty) }, where: { id: String(item.id) }, lock: Number(item.version) }] : []),
    ]);
    return { id: orderId, orderStatus: "cancelled" };
  },

  // an after hook gets every row the statement touched: loop, never rows[0]
  recordOrders: async (_input, ctx) => {
    if (ctx.cause.kind !== "lifecycle") return {};
    await ctx.store.write(ctx.cause.rows.map((row) => ({
      insert: "activity" as const,
      values: { kind: ctx.cause.kind === "lifecycle" ? ctx.cause.hook : "", subject: String(row.id), detail: `${String(row.orderStatus)} x${String(row.qty)}` },
    })));
    return {};
  },

  // a schedule runs as the system caller: no scope, and no requires.auth predicate holds for it
  weeklyDigest: async (_input, ctx) => {
    const { rows } = await ctx.store.select({ from: "orders", columns: ["qty"], where: { orderStatus: "placed" }, limit: 500 });
    const units = rows.reduce((sum, row) => sum + Number(row.qty), 0);
    await ctx.store.write([{ insert: "activity", values: { kind: "weekly-digest", subject: String(ctx.cause.kind === "schedule" ? ctx.cause.scheduledTime : ""), detail: `${rows.length} orders, ${units} units` } }]);
    return {};
  },
};
