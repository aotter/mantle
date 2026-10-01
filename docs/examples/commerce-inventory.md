---
description: A guest checkout that re-prices on the server, reserves stock atomically in Store, expires unpaid orders on a schedule and settles from a verified payment callback.
---
# Commerce inventory: reservations, expiry and settlement

[Examples hub](./README.md) · Without stock or payments, this is [Commerce catalog and orders](./commerce.md).

The most involved pattern here. Staff publish a catalog. A guest's order is
re-priced on the server and reserves stock; payment arrives later from a
provider callback, never from the browser; an unpaid order is released after
fifteen minutes. Every stock change writes an audit row in the same atomic
write.

## Problem

Stock must never go negative, two guests must never buy the last unit, and an
order, its reservation and its audit rows must change together or not at all.
Staff adjust stock, fulfil paid orders and read a picking list.

In 0.1.x this needed a Durable Object as the stock authority and a Queue for
expiry. In 0.2.0 Store is enough: a `write` applies all its operations or none,
`checks` refuse a negative count in the database, and an optimistic lock on
each inventory row turns a race into a `CONFLICT` the client retries.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: products }
spec:
  title: Products
  lifecycle: publishing
  uniqueIndexes: [[slug]]
  schema:
    type: object
    additionalProperties: false
    required: [slug, title, priceMinor, currency]
    properties:
      slug: { type: string, pattern: "^[a-z0-9-]+$" }
      title: { type: string, minLength: 1, maxLength: 160 }
      summary: { type: string, maxLength: 500 }
      priceMinor: { type: integer, minimum: 0, x-mcp-hint: money-minor }
      currency: { type: string, pattern: "^[A-Z]{3}$" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: inventory }
spec:
  title: Inventory
  description: Stock per product. Only the declared Procedures change it.
  lifecycle: operational
  checks: ["available >= 0", "reserved >= 0"]
  uniqueIndexes: [[productSlug]]
  uiSchema:
    list: { primaryField: productSlug, columns: [available, reserved] }
  schema:
    type: object
    readOnly: true
    required: [productSlug, available, reserved]
    properties:
      productSlug: { type: string, x-mantle-ref: { schema: products, field: slug } }
      available: { type: integer }
      reserved: { type: integer }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: inventory-movements }
spec:
  title: Inventory movements
  description: Append-only audit trail, written in the same write as each stock change.
  lifecycle: operational
  uniqueIndexes: [[movementKey]]
  indexes: [[productSlug], [orderToken]]
  schema:
    type: object
    readOnly: true
    required: [movementKey, productSlug, kind, availableDelta, reservedDelta]
    properties:
      movementKey: { type: string }
      productSlug: { type: string }
      orderToken: { type: string }
      kind: { type: string, enum: [adjust, reserve, sale, release] }
      availableDelta: { type: integer }
      reservedDelta: { type: integer }
      note: { type: string }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  description: Guest orders, written only by the declared Procedures.
  lifecycle: operational
  uniqueIndexes: [[orderToken]]
  indexes: [[orderStatus, expiresAt]]
  searchableFields: [orderToken, customerName, customerEmail]
  uiSchema:
    list: { primaryField: orderToken, columns: [orderStatus, customerEmail, totalMinor] }
  schema:
    type: object
    readOnly: true
    required: [orderToken, orderStatus, currency, totalMinor, customerName, customerEmail, shippingAddress, items, expiresAt]
    properties:
      orderToken: { type: string }
      orderStatus: { type: string, enum: [pending_payment, paid, fulfilled, cancelled] }
      currency: { type: string, pattern: "^[A-Z]{3}$" }
      totalMinor: { type: integer, minimum: 0, x-mcp-hint: money-minor }
      customerName: { type: string, minLength: 1, maxLength: 120 }
      customerEmail: { type: string, format: email }
      shippingAddress: { type: string, minLength: 1, maxLength: 500 }
      items:
        type: array
        items:
          type: object
          required: [productSlug, title, quantity, unitPriceMinor]
          properties:
            productSlug: { type: string }
            title: { type: string }
            quantity: { type: integer, minimum: 1 }
            unitPriceMinor: { type: integer, minimum: 0 }
      expiresAt: { type: string, format: date-time }
      trackingNumber: { type: string }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: public-products }
spec:
  surface: public
  description: The published catalog with what is in stock.
  sql: |
    SELECT p.id, p.slug, p.title, p.summary, p.priceMinor, p.currency, coalesce(i.available, 0) AS available
    FROM products p LEFT JOIN inventory i ON i.productSlug = p.slug
    ORDER BY p.slug LIMIT 100
---
# Internal: no surface lists it. The expiry handler reads it; SQL compares the times.
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: expired-orders }
spec:
  surface: internal
  sql: |
    SELECT id, version, orderToken, items FROM orders
    WHERE orderStatus = 'pending_payment' AND expiresAt < now()
    ORDER BY expiresAt LIMIT 100
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: picking-list }
spec:
  title: Picking list
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  sql: |
    SELECT o.orderToken, o.customerName, o.shippingAddress,
           item.value ->> 'productSlug' AS "productSlug",
           item.value ->> 'title' AS "productTitle",
           item.value ->> 'quantity' AS quantity
    FROM orders o, json_each(o.items) item
    WHERE o.orderStatus = 'paid'
    ORDER BY o.created_at LIMIT 200
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: place-order }
spec:
  title: Place order
  description: Price a cart from the published catalog, reserve its stock and return a token to pay within fifteen minutes.
  input:
    type: object
    additionalProperties: false
    required: [customerName, customerEmail, shippingAddress, items]
    properties:
      customerName: { type: string, minLength: 1, maxLength: 120 }
      customerEmail: { type: string, format: email }
      shippingAddress: { type: string, minLength: 1, maxLength: 500 }
      items:
        type: array
        minItems: 1
        maxItems: 20
        items:
          type: object
          additionalProperties: false
          required: [productSlug, quantity]
          properties:
            productSlug: { type: string, pattern: "^[a-z0-9-]+$" }
            quantity: { type: integer, minimum: 1, maximum: 99 }
  output:
    type: object
    required: [orderToken, expiresAt, totalMinor, currency]
    properties:
      orderToken: { type: string }
      expiresAt: { type: string }
      totalMinor: { type: integer }
      currency: { type: string }
  handler: { ref: placeOrder }
---
# No Trigger: only the service's verified payment callback calls it, as the system caller.
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: settle-order }
spec:
  input:
    type: object
    additionalProperties: false
    required: [orderToken]
    properties:
      orderToken: { type: string }
  output:
    type: object
    required: [outcome]
    properties:
      outcome: { type: string, enum: [paid, already_paid, expired, missing] }
  handler: { ref: settleOrder }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: release-expired-orders }
spec:
  input: { type: object }
  output:
    type: object
    properties:
      released: { type: integer }
  handler: { ref: releaseExpiredOrders }
---
# SQL is enough when a write needs no read first. The movement row comes first: a replayed operationId
# fails its unique index, so the whole write is refused and the stock is not changed twice.
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: adjust-inventory }
spec:
  title: Adjust inventory
  description: Add or remove available stock for one product, with a reason. Reuse the operationId on retry.
  requires: { auth: { all: [{ ctx.staff: [owner] }] } }
  input:
    type: object
    additionalProperties: false
    required: [operationId, productSlug, delta, reason]
    properties:
      operationId: { type: string, format: uuid, x-mcp-hint: idempotency-key }
      productSlug: { type: string, pattern: "^[a-z0-9-]+$", x-mantle-ref: { schema: products, field: slug } }
      delta: { type: integer, minimum: -100000, maximum: 100000 }
      reason: { type: string, minLength: 1, maxLength: 500 }
  uiSchema:
    fields:
      reason: { widget: textarea }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO "inventory-movements" (movementKey, productSlug, kind, availableDelta, reservedDelta, note)
      VALUES (input.operationId, input.productSlug, 'adjust', input.delta, 0, input.reason);
      INSERT INTO inventory (productSlug, available, reserved) VALUES (input.productSlug, input.delta, 0)
      ON CONFLICT (productSlug) DO UPDATE SET available = inventory.available + EXCLUDED.available
      RETURNING productSlug AS "productSlug", available, reserved
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: fulfill-order }
spec:
  title: Fulfill order
  description: Mark a paid order fulfilled, with an optional tracking number.
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  input:
    type: object
    additionalProperties: false
    required: [id, expectedVersion]
    properties:
      id: { type: string, x-mantle-ref: orders }
      expectedVersion: { type: integer, minimum: 1 }
      trackingNumber: { type: string, maxLength: 120 }
  output: { type: object }
  handler:
    sql: |
      UPDATE orders SET orderStatus = 'fulfilled', trackingNumber = COALESCE(input.trackingNumber, trackingNumber)
      WHERE id = input.id AND version = input.expectedVersion AND orderStatus = 'paid'
      RETURNING id, version
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: place-order-http }
spec:
  source: { kind: http, method: POST, path: /api/commerce/orders }
  target: { procedure: place-order }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: adjust-inventory-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: adjust-inventory }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: fulfill-order-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: fulfill-order }
---
# POSIX cron, UTC: every five minutes.
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: release-expired-orders }
spec:
  source: { kind: schedule, cron: "*/5 * * * *" }
  target: { procedure: release-expired-orders }
```

Points worth noticing:

- **Root `readOnly: true`** on `orders`, `inventory` and `inventory-movements`
  keeps Admin from offering generic edits. Only the declared Procedures change
  them.
- **`checks` are the last line.** The handlers compute new counts from rows
  they read under a lock, so a race is a `CONFLICT`; the checks make a negative
  count impossible whatever writes the row.
- **`settle-order` and `release-expired-orders` have no HTTP or MCP Trigger.**
  The schedule runs the second as the system caller, and only the service's own
  callback route invokes the first. A system caller satisfies no
  `requires.auth` predicate, so both declare none.
- **`expired-orders` is `internal`:** callable only through
  `ctx.store.view` or `runtime.store`. SQL compares `expiresAt` with `now()`.
- **`picking-list`** unnests order lines with `json_each`, the one comma join
  the dialect allows.

## Handlers

```ts
// src/handlers.ts
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle/spec";
import type { MantleHandlers } from "../.mantle/generated/mantle.js";
import type { Env } from "./service.js";

const CHECKOUT_TTL_MS = 15 * 60 * 1000;
type Line = { readonly productSlug: string; readonly quantity: number };
type Ctx = Parameters<MantleHandlers<Env>["placeOrder"]>[1];
type Op = Parameters<Ctx["store"]["write"]>[0][number];

const fail = (code: "CONFLICT" | "INPUT_VALIDATION_FAILED", path: string, message: string): never => {
  throw new DiagnosticError(runtimeDiagnostic({ code, severity: "error", path, message }));
};

/** One locked update per product, plus its audit row: every count comes from a row read here, so a race is a CONFLICT. */
async function stockOps(ctx: Ctx, lines: readonly Line[], kind: "reserve" | "sale" | "release", orderToken: string): Promise<Op[]> {
  const qty = new Map<string, number>();
  for (const l of lines) qty.set(l.productSlug, (qty.get(l.productSlug) ?? 0) + l.quantity);
  const { rows } = await ctx.store.select({ from: "inventory", where: { productSlug: { in: [...qty.keys()] } } });
  const ops: Op[] = [];
  for (const [slug, q] of qty) {
    const row = rows.find((r) => r.productSlug === slug) ?? fail("INPUT_VALIDATION_FAILED", "/items", `no stock record for ${slug}`);
    const [availableDelta, reservedDelta] = kind === "reserve" ? [-q, q] : kind === "sale" ? [0, -q] : [q, -q];
    ops.push(
      { update: "inventory", set: { available: Number(row.available) + availableDelta, reserved: Number(row.reserved) + reservedDelta }, where: { id: String(row.id) }, lock: Number(row.version) },
      { insert: "inventory-movements", values: { movementKey: `${orderToken}:${kind}:${slug}`, productSlug: slug, orderToken, kind, availableDelta, reservedDelta } },
    );
  }
  return ops;
}

export const handlers: MantleHandlers<Env> = {
  placeOrder: async (input, ctx) => {
    // re-price from published products only; a draft or unknown slug is refused
    const slugs = [...new Set(input.items.map((l) => l.productSlug))];
    const { rows: products } = await ctx.store.select({ from: "products", where: { slug: { in: slugs }, status: "published" } });
    const lines = input.items.map((l) => {
      const p = products.find((r) => r.slug === l.productSlug) ?? fail("INPUT_VALIDATION_FAILED", "/items", `${l.productSlug} is not for sale`);
      return { productSlug: l.productSlug, title: String(p.title), quantity: l.quantity, unitPriceMinor: Number(p.priceMinor), currency: String(p.currency) };
    });
    const currency = lines[0]!.currency;
    if (lines.some((l) => l.currency !== currency)) fail("INPUT_VALIDATION_FAILED", "/items", "one order has one currency");
    const totalMinor = lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0);
    const orderToken = ctx.store.id();
    const expiresAt = new Date(Date.now() + CHECKOUT_TTL_MS).toISOString();
    // the order, the reservation and its audit rows: all or nothing. Too little stock fails a check; a race fails a lock.
    await ctx.store.write([
      { insert: "orders", values: {
        orderToken, orderStatus: "pending_payment", currency, totalMinor, expiresAt,
        customerName: input.customerName, customerEmail: input.customerEmail, shippingAddress: input.shippingAddress,
        items: lines.map(({ currency: _c, ...line }) => line),
      } },
      ...(await stockOps(ctx, lines, "reserve", orderToken)),
    ]);
    return { orderToken, expiresAt, totalMinor, currency };
  },

  settleOrder: async ({ orderToken }, ctx) => {
    const [order] = (await ctx.store.select({ from: "orders", where: { orderToken } })).rows;
    if (!order) return { outcome: "missing" };
    if (order.orderStatus !== "pending_payment") return { outcome: order.orderStatus === "cancelled" ? "expired" : "already_paid" };
    const lines = order.items as unknown as Line[];
    // a payment that lands after the deadline releases the stock instead of selling it; the provider refunds
    const late = Date.parse(String(order.expiresAt)) <= Date.now();
    await ctx.store.write([
      { update: "orders", set: { orderStatus: late ? "cancelled" : "paid" }, where: { id: String(order.id) }, lock: Number(order.version) },
      ...(await stockOps(ctx, lines, late ? "release" : "sale", orderToken)),
    ]);
    return { outcome: late ? "expired" : "paid" };
  },

  // runs as the system caller every five minutes; one write per order, so one CONFLICT never blocks the rest
  releaseExpiredOrders: async (_input, ctx) => {
    const { rows } = await ctx.store.view("expired-orders");
    let released = 0;
    for (const order of rows) {
      try {
        await ctx.store.write([
          { update: "orders", set: { orderStatus: "cancelled" }, where: { id: String(order.id) }, lock: Number(order.version) },
          ...(await stockOps(ctx, order.items as unknown as Line[], "release", String(order.orderToken))),
        ]);
        released++;
      } catch (error) {
        // a payment settled it first, or a stock row changed: the next run reads it again
        if (!(error instanceof DiagnosticError && error.diagnostic.code === "CONFLICT")) throw error;
      }
    }
    return { released };
  },
};
```

## The payment callback

A provider signs its callback over the raw body, so it is verified in the
service's own `fetch`, before any surface. Only a verified event reaches
`settle-order`, as the system caller. In `src/service.ts`:

```ts
import { systemCaller } from "@aotter/mantle";

// inside the function the service's fetch returns, before the auth routes:
if (pathname === "/payments/callback" && request.method === "POST") {
  const raw = await request.text();
  const event = await verifyProviderEvent(raw, request.headers.get("x-provider-signature"), env.PAYMENT_WEBHOOK_SECRET);
  if (!event) return new Response("invalid signature", { status: 400 });
  if (event.type !== "payment.succeeded") return new Response("ignored");
  await runtime.invokeProcedure({
    procedure: "settle-order",
    input: { orderToken: event.orderToken },
    caller: systemCaller("payment-callback"),
    cause: { kind: "internal", id: event.id }, // the provider's event id: stable across its retries
  });
  return new Response("OK"); // paid, already_paid, expired and missing are all final for the provider
}
```

`verifyProviderEvent` is the provider SDK's signature check, with
`PAYMENT_WEBHOOK_SECRET` as a Worker secret. A thrown `CONFLICT` (a
concurrent expiry) answers 500 here, so the provider retries and the next
attempt reads the settled state.

## Try it

```sh
curl -sS -X POST http://127.0.0.1:8787/api/commerce/orders \
  -H 'content-type: application/json' \
  -d '{"customerName":"Ada","customerEmail":"ada@example.test","shippingAddress":"1 Shell Lane","items":[{"productSlug":"notebook","quantity":2}]}'
```

The answer carries `orderToken`, `expiresAt`, and the total from the
published price. An unknown or unpublished product is HTTP 400. Ordering more
than is available fails the `available >= 0` check, also HTTP 400 (`CHECK
inventory: available >= 0`), and writes nothing. Two guests racing for one
row: one succeeds, the other gets `CONFLICT` and retries.

Staff, on `/mcp/staff`: `adjust_inventory` (Admin generates the
`operationId`), `fulfill_order` and `picking_list`. Fire the schedule locally
with `curl 'http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*'` under
`wrangler dev --test-scheduled`.

## What this leaves out

- **Refunds.** A late payment releases stock; refunding it is the provider's
  API, from a `ref` handler.
- **Guest cancellation.** It would be one more Procedure shaped like
  `settleOrder` with `"release"`, authorized by the order token.
- **More than 100 expired orders per run.** The next run takes the rest.

## Source

- [Writes: Procedures, Triggers and hooks](../handbook/concepts/procedures-and-triggers.md): atomic writes, locks, schedules
- [The service and its entry](../handbook/cloudflare/service-entry.md): a route before the surfaces
