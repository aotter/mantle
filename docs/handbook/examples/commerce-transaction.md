---
description: A guest checkout with a Durable Object as stock authority, Queue-based order expiry, and a verified payment-provider callback.
---
# Commerce: catalog, orders, inventory authority and asynchronous settlement

This example is the most involved pattern in the set. It publishes a catalog, accepts guest orders, reserves stock exactly once in an application-owned Durable Object, expires unpaid orders through a Queue with a cron sweep as recovery, and shows where a real payment provider plugs in. Read it if money and stock are involved.

## Problem

Staff publish products with a price. A guest places an order for one or more products; the server re-prices every line, reserves stock, and returns an order token with a fifteen-minute payment deadline. Payment arrives asynchronously from a provider callback, never from the browser. If payment does not arrive in time the reservation is released. Staff adjust stock, fulfil paid orders and read a picking list, all through Admin or Staff MCP, and every stock change is auditable. Mantle stores the query mirrors; the Durable Object is the only writer of truth for stock.

## Manifest

Trimmed to the essentials that stay valid together. Localized product copy is omitted; see [Publication](./publication.md) for the parent/child pattern.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: products
spec:
  title: Products
  lifecycle: publishing
  uniqueIndexes:
    - [slug]
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
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: orders
spec:
  title: Orders
  description: Guest orders created by checkout and maintained only by declared Procedures.
  lifecycle: operational
  uniqueIndexes:
    - [orderToken]
    - [orderNumber]
  indexes:
    - [orderStatus]
  searchableFields: [orderNumber, customerName, customerEmail]
  uiSchema:
    list:
      filterField: orderStatus
      primaryField: orderNumber
      columns: [orderStatus, customerEmail, totalMinor]
  schema:
    readOnly: true
    type: object
    required: [orderToken, orderNumber, orderStatus, currency, totalMinor, customerName, customerEmail, shippingAddress, items, expiresAt]
    properties:
      orderToken: { type: string, pattern: "^[0-9a-f-]{36}$" }
      orderNumber: { type: string }
      orderStatus: { type: string, enum: [pending_payment, paid, fulfilled, cancelled] }
      currency: { type: string, pattern: "^[A-Z]{3}$" }
      totalMinor: { type: integer, minimum: 0, x-mcp-hint: money-minor }
      customerName: { type: string, minLength: 1, maxLength: 120 }
      customerEmail: { type: string, format: email }
      shippingAddress: { type: string, minLength: 1, maxLength: 500 }
      items:
        type: array
        minItems: 1
        maxItems: 20
        items:
          type: object
          required: [productSlug, title, quantity, unitPriceMinor, lineTotalMinor]
          properties:
            productSlug: { type: string }
            title: { type: string }
            quantity: { type: integer, minimum: 1, maximum: 99 }
            unitPriceMinor: { type: integer, minimum: 0 }
            lineTotalMinor: { type: integer, minimum: 0 }
      expiresAt: { type: number, x-mcp-hint: timestamp-ms }
      paidAt: { type: number, x-mcp-hint: timestamp-ms }
      fulfilledAt: { type: number, x-mcp-hint: timestamp-ms }
      cancelledAt: { type: number, x-mcp-hint: timestamp-ms }
      trackingNumber: { type: string }
      cancelReason: { type: string }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: inventory
spec:
  title: Inventory
  description: Query mirror of the InventoryCoordinator Durable Object, which is the stock authority.
  lifecycle: operational
  uniqueIndexes:
    - [productSlug]
  indexes:
    - [available, productSlug]
  uiSchema:
    list:
      primaryField: productSlug
      columns: [available, reserved, revision]
  schema:
    readOnly: true
    type: object
    required: [productSlug, available, reserved, revision]
    properties:
      productSlug: { type: string }
      available: { type: integer, minimum: 0 }
      reserved: { type: integer, minimum: 0 }
      revision: { type: integer, minimum: 0 }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: inventory-movements
spec:
  title: Inventory movements
  description: Append-only audit trail for stock changes caused by checkout and staff operations.
  lifecycle: operational
  uniqueIndexes:
    - [movementKey]
  indexes:
    - [kind, occurredAt]
    - [productSlug, occurredAt]
    - [orderToken]
  uiSchema:
    list:
      filterField: kind
      primaryField: productSlug
      columns: [kind, availableDelta, reservedDelta, occurredAt]
  schema:
    readOnly: true
    type: object
    required: [movementKey, productSlug, kind, availableDelta, reservedDelta, occurredAt]
    properties:
      movementKey: { type: string }
      productSlug: { type: string }
      orderToken: { type: string }
      kind: { type: string, enum: [adjust, reserve, sale, release, cancellation] }
      availableDelta: { type: integer }
      reservedDelta: { type: integer }
      note: { type: string }
      occurredAt: { type: number, x-mcp-hint: timestamp-ms }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: public-products
spec:
  surface: public
  from: products
  fields: [id, slug, title, summary, priceMinor, currency, updatedAt]
  filter:
    eq: { field: status, value: published }
  orderBy:
    - { field: slug, direction: asc }
  limit: 100
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: picking-list
spec:
  title: Picking list
  surface: staff
  uiSchema:
    list:
      columns: [orderNumber, customerName, shippingAddress, productSlug, productTitle, quantity]
      searchFields: [orderNumber, customerName, shippingAddress, productSlug, productTitle]
  sql: |
    SELECT
      o.orderNumber,
      o.customerName,
      o.shippingAddress,
      json_extract(item.value, '$.productSlug') AS productSlug,
      json_extract(item.value, '$.title') AS productTitle,
      json_extract(item.value, '$.quantity') AS quantity
    FROM orders AS o
    JOIN json_each(o.items) AS item
    WHERE o.orderStatus = 'paid'
    ORDER BY o.createdAt ASC, o.orderNumber ASC, item.key ASC
  limit: 200
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: place-order
spec:
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
    required: [outcome, orderToken, orderNumber, expiresAt, totalMinor, currency]
    properties:
      outcome: { type: string, enum: [pending_payment] }
      orderToken: { type: string }
      orderNumber: { type: string }
      expiresAt: { type: number }
      totalMinor: { type: integer }
      currency: { type: string }
  handler: { kind: ref, ref: placeOrder }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: pay-order
spec:
  input:
    type: object
    additionalProperties: false
    required: [orderToken]
    properties:
      orderToken: { type: string, pattern: "^[0-9a-f-]{36}$" }
  output:
    type: object
    required: [outcome, orderToken]
    properties:
      outcome: { type: string, enum: [paid, already_paid, expired, closed, missing] }
      orderToken: { type: string }
  handler: { kind: ref, ref: payOrder }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: cancel-guest-order
spec:
  input:
    type: object
    additionalProperties: false
    required: [orderToken]
    properties:
      orderToken: { type: string, pattern: "^[0-9a-f-]{36}$" }
  output:
    type: object
    required: [outcome, orderToken]
    properties:
      outcome: { type: string, enum: [cancelled, already_cancelled, closed, missing] }
      orderToken: { type: string }
  handler: { kind: ref, ref: cancelGuestOrder }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: adjust-inventory
spec:
  title: Adjust inventory
  requires:
    auth:
      all:
        - { "ctx.staff": [owner] }
  input:
    type: object
    additionalProperties: false
    required: [operationId, productSlug, delta, reason]
    properties:
      operationId: { type: string, format: uuid, x-mcp-hint: idempotency-key }
      productSlug: { type: string, pattern: "^[a-z0-9-]+$", x-mantle-ref: products }
      delta: { type: integer, minimum: -100000, maximum: 100000 }
      reason: { type: string, minLength: 1, maxLength: 500 }
  uiSchema:
    fields:
      reason: { widget: textarea }
  output:
    type: object
    required: [productSlug, available, reserved, revision]
    properties:
      productSlug: { type: string }
      available: { type: integer }
      reserved: { type: integer }
      revision: { type: integer }
  handler: { kind: ref, ref: adjustInventory }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: fulfill-order
spec:
  title: Fulfill order
  requires:
    auth:
      all:
        - { "ctx.staff": [owner] }
  input:
    type: object
    additionalProperties: false
    required: [orderToken]
    properties:
      orderToken: { type: string, pattern: "^[0-9a-f-]{36}$", x-mantle-ref: orders }
      trackingNumber: { type: string, maxLength: 120 }
  output:
    type: object
    required: [outcome, orderToken]
    properties:
      outcome: { type: string, enum: [fulfilled, already_fulfilled, closed, missing] }
      orderToken: { type: string }
  handler: { kind: ref, ref: fulfillOrder }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: expire-order
spec:
  input:
    type: object
    additionalProperties: false
    required: [orderToken, now]
    properties:
      orderToken: { type: string, pattern: "^[0-9a-f-]{36}$" }
      now: { type: number }
  output:
    type: object
    required: [outcome, orderToken]
    properties:
      outcome: { type: string, enum: [expired, too_early, closed, missing] }
      orderToken: { type: string }
  handler: { kind: ref, ref: expireOrder }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: sweep-expired-orders
spec:
  input:
    type: object
    additionalProperties: false
    required: [now]
    properties:
      now: { type: number }
  output:
    type: object
    required: [checked, expired]
    properties:
      checked: { type: integer }
      expired: { type: integer }
  handler: { kind: ref, ref: sweepExpiredOrders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: place-order-http
spec:
  source: { kind: http, method: POST, path: /api/commerce/orders }
  target: { procedure: place-order }
---
# Demo only. Remove before connecting a real provider; see "Where the payment provider plugs in".
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: pay-order-http
spec:
  source: { kind: http, method: POST, path: /api/commerce/orders/pay }
  target: { procedure: pay-order }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: cancel-guest-order-http
spec:
  source: { kind: http, method: POST, path: /api/commerce/orders/cancel }
  target: { procedure: cancel-guest-order }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: adjust-inventory-mcp
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: adjust-inventory }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: fulfill-order-mcp
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: fulfill-order }
```

Points worth noticing:

- `orders`, `inventory` and `inventory-movements` set root `schema.readOnly: true`. Admin and Staff MCP keep list and detail access and the declared row Procedures, but suppress and reject generic create, update, status and delete. Only handlers maintain these projections.
- `expire-order` and `sweep-expired-orders` have **no Trigger**. They are internal Procedures: the Queue consumer and the cron handler invoke them through the generated binding. Nothing external can call them.
- `adjust-inventory.operationId` carries `x-mcp-hint: idempotency-key`; Admin generates a hidden UUID per form, and other callers must reuse theirs on retry. `productSlug` carries `x-mantle-ref: products`, so Admin offers "Adjust inventory" on each product row with the slug prefilled. `fulfill-order.orderToken` does the same on `orders` rows.
- `picking-list` is a raw `sql` staff View using `json_each` to unnest order lines. `sql` Views run on SQLite storage only.

See [Reads: Views, REST and MCP](../concepts/views.md) and the [Schema reference](../reference/schema.md).

## Worker and handlers

### Bindings and Worker entry

```ts
// src/env.ts
import type { MantleCloudflareEnv } from "@aotter/mantle/cloudflare";
import type { InventoryCoordinator } from "./commerce/InventoryCoordinator.js";

export type ExpiryMessage = { readonly type: "expire-order"; readonly orderToken: string };

export interface Env extends MantleCloudflareEnv {
  readonly INVENTORY_COORDINATOR: DurableObjectNamespace<InventoryCoordinator>;
  readonly ORDER_EXPIRY_QUEUE: Queue<ExpiryMessage>;
  readonly PAYMENT_WEBHOOK_SECRET?: string;
}
```

```toml
# wrangler.toml (additions)
[[durable_objects.bindings]]
name = "INVENTORY_COORDINATOR"
class_name = "InventoryCoordinator"

[[migrations]]
tag = "inventory-v1"
new_sqlite_classes = ["InventoryCoordinator"]

[[queues.producers]]
binding = "ORDER_EXPIRY_QUEUE"
queue = "shop-order-expiry"

[[queues.consumers]]
queue = "shop-order-expiry"
max_concurrency = 1
max_batch_size = 10
max_retries = 5
retry_delay = 30
dead_letter_queue = "shop-order-expiry-dlq"

[triggers]
crons = ["*/5 * * * *"]
```

```ts
// src/index.ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { bindMantle, plan } from "../.mantle/generated/mantle.js";
import { buildCommerceHandlers } from "./commerce/handlers.js";
import { verifyProviderEvent } from "./commerce/provider.js";
import type { Env, ExpiryMessage } from "./env.js";

export { InventoryCoordinator } from "./commerce/InventoryCoordinator.js";

const worker = createMantleWorker<Env>({
  plan,
  extend: ({ getRuntime, env }) => ({
    handlers: buildCommerceHandlers(getRuntime),
    mount({ app }) {
      // Provider callback: raw body + signature, outside the JSON HTTP Trigger path.
      app.post("/payments/callback", async (c) => {
        const raw = await c.req.text();
        const event = await verifyProviderEvent(raw, c.req.header("x-provider-signature"), env.PAYMENT_WEBHOOK_SECRET);
        if (!event) return c.text("invalid signature", 400);
        if (event.type !== "payment.succeeded") return c.text("ignored", 200);
        const api = bindMantle(await getRuntime());
        const result = await api.procedures.payOrder(
          { orderToken: event.orderToken },
          { user: null, staff: null, env, waitUntil: (p) => c.executionCtx.waitUntil(p) },
        );
        if (!result.ok) return c.text(result.diagnostic.code, result.diagnostic.code === "INTERNAL_ERROR" ? 500 : 200);
        return c.text("OK", 200); // paid, already_paid, expired, closed, missing are all terminal for the provider
      });
    },
  }),
});

function internalContext(env: Env, ctx: ExecutionContext) {
  return {
    user: null,
    staff: null,
    env,
    waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
  } as const;
}

export default {
  fetch: worker.fetch,

  async queue(batch: MessageBatch<ExpiryMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    let api: ReturnType<typeof bindMantle>;
    try {
      api = bindMantle(await worker.getRuntime(env));
    } catch (error) {
      console.error("[order-expiry] runtime unavailable", error);
      batch.retryAll();
      return;
    }
    for (const message of batch.messages) {
      const body = message.body;
      if (body?.type !== "expire-order" || typeof body.orderToken !== "string") {
        console.error("[order-expiry] discarded malformed message", message.id);
        message.ack();
        continue;
      }
      try {
        const result = await api.procedures.expireOrder({ orderToken: body.orderToken, now: Date.now() }, internalContext(env, ctx));
        if (!result.ok) {
          if (result.diagnostic.code === "INTERNAL_ERROR" || result.diagnostic.code === "CONFLICT") message.retry();
          else message.ack();
        } else if (result.data.outcome === "too_early") {
          message.retry({ delaySeconds: 60 });
        } else {
          message.ack();
        }
      } catch (error) {
        console.error("[order-expiry] transient failure", message.id, error);
        message.retry();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const api = bindMantle(await worker.getRuntime(env));
    const result = await api.procedures.sweepExpiredOrders({ now: Date.now() }, internalContext(env, ctx));
    if (!result.ok) throw new Error(`expiry sweep failed: ${result.diagnostic.code}`);
  },
} satisfies ExportedHandler<Env, ExpiryMessage>;
```

`worker.getRuntime(env)` returns the same booted runtime `fetch` uses; `bindMantle(runtime).procedures.<lowerCamel>(input, ctx)` runs the full Procedure pipeline (auth predicates, input validation, handler, output validation) and returns `{ ok: true, data } | { ok: false, diagnostic }`.

`internalContext` is a **system caller**: `user: null, staff: null` and no `auth`. It satisfies no `requires.auth` predicate, so it can only invoke Procedures that declare none. That is intentional. `expire-order` and `sweep-expired-orders` have no `requires` and no Trigger, so the Queue and cron are their only callers. Never hand this context to a staff-guarded Procedure to "skip" authorization; declare an internal Procedure instead.

### Inventory authority in a Durable Object

One `InventoryCoordinator` instance per shop (`env.INVENTORY_COORDINATOR.getByName("site")`) keeps every SKU's counts and every order's reservation in one storage namespace, so a multi-product cart reserves atomically. Every method runs in `this.ctx.storage.transaction`, checks the current state, and returns a prior outcome when repeated.

```ts
// src/commerce/InventoryCoordinator.ts (abridged)
import { DurableObject } from "cloudflare:workers";

export type StockItem = { readonly productSlug: string; readonly quantity: number };
export type StockSnapshot = { readonly productSlug: string; readonly available: number; readonly reserved: number; readonly revision: number };
type OrderState = { readonly items: readonly StockItem[]; readonly expiresAt: number; readonly status: "pending_payment" | "paid" | "fulfilled" | "cancelled" | "expired" };

export class InventoryCoordinator extends DurableObject {
  reserve(orderId: string, items: readonly StockItem[], expiresAt: number) {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<OrderState>(`order:${orderId}`);
      if (existing) return existing.status === "pending_payment" ? { outcome: "already_reserved" as const } : { outcome: "closed" as const };
      // read every SKU; reject if any lacks stock; otherwise available -= q, reserved += q, revision += 1
      // then txn.put(`order:${orderId}`, { items, expiresAt, status: "pending_payment" })
      return { outcome: "reserved" as const, snapshots: [] as StockSnapshot[] };
    });
  }

  pay(orderId: string, now: number) {
    return this.ctx.storage.transaction(async (txn) => {
      const order = await txn.get<OrderState>(`order:${orderId}`);
      if (!order) return { outcome: "missing" as const };
      if (order.status === "paid") return { outcome: "already_paid" as const, items: order.items };
      if (order.status !== "pending_payment") return { outcome: "closed" as const };
      if (order.expiresAt <= now) return release(txn, orderId, order, "expired"); // late payment: release, do not sell
      // reserved -= q for each item; status -> paid
      return { outcome: "paid" as const, items: order.items };
    });
  }

  expire(orderId: string, now: number) { /* pending_payment && expiresAt <= now -> release(...,"expired"); else too_early / closed / missing */ }
  cancel(orderId: string) { /* pending_payment -> release; paid -> available += q; fulfilled|expired -> closed */ }
  fulfill(orderId: string) { /* paid -> fulfilled; repeat -> already_fulfilled */ }

  adjust(operationId: string, productSlug: string, delta: number, reason: string) {
    return this.ctx.storage.transaction(async (txn) => {
      const applied = await txn.get<{ productSlug: string; delta: number; reason: string; snapshot: StockSnapshot }>(`adjustment:${operationId}`);
      if (applied) {
        return applied.productSlug === productSlug && applied.delta === delta && applied.reason === reason
          ? { outcome: "already_adjusted" as const, snapshot: applied.snapshot }
          : { outcome: "idempotency_conflict" as const };
      }
      // available + delta must stay >= 0; write inventory:<slug> and adjustment:<operationId>
      return { outcome: "adjusted" as const, snapshot: {} as StockSnapshot };
    });
  }
}
```

Storage keys are `inventory:<slug>`, `order:<orderToken>` and `adjustment:<operationId>`. An adjustment key is bound to product, delta and reason: reusing it with different input is `idempotency_conflict`, which the handler maps to `CONFLICT` (409), not a second stock change.

The Mantle `inventory` and `inventory-movements` rows are **query mirrors**. Handlers write them only through runtime write use cases (`runtime.createDraft`, `runtime.updateDraft`, `runtime.deleteEntry`, each of which is live on an operational Schema), never through Mantle's tables. The mirror is revision-guarded: a snapshot older than the stored `revision` is skipped, and a version race on `updateDraft` is retried. Movement rows use a deterministic `movementKey` (`reserve:<orderToken>:<slug>`, `sale:<orderToken>:<slug>`, `adjust:<operationId>`) and are inserted only if absent, so replaying any step cannot double-record.

```ts
// src/commerce/handlers.ts (abridged)
import type { HandlerContext, MantleRuntime } from "@aotter/mantle/runtime";
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle/spec";
import type { MantleHandlers } from "../../.mantle/generated/mantle.js";
import type { Env } from "../env.js";

const CHECKOUT_TTL_MS = 15 * 60 * 1000;
const inventory = (env: Env) => env.INVENTORY_COORDINATOR.getByName("site");

export function buildCommerceHandlers(getRuntime: () => Promise<MantleRuntime>): MantleHandlers<Env> {
  return {
    placeOrder: async (input, ctx) => {
      const runtime = await getRuntime();
      const orderToken = crypto.randomUUID();
      // 1. re-price on the server from published products; reject unknown slugs or mixed currencies
      const priced = await priceItems(runtime, input.items);
      const now = Date.now();
      const expiresAt = now + CHECKOUT_TTL_MS;
      // 2. reserve in the DO first; insufficient stock -> CONFLICT
      const reserved = await inventory(ctx.env).reserve(orderToken, priced.stockItems, expiresAt);
      if (reserved.outcome !== "reserved") throw conflict("/items", reserved, "quantities currently in stock");
      // 3. project into Mantle; on failure compensate in the DO and remove any partial row
      let created: { id: string } | null = null;
      try {
        created = await runtime.createDraft.execute({
          collection: "orders",
          authorId: null,
          ctx,
          data: { orderToken, orderNumber: orderNumber(now, orderToken), orderStatus: "pending_payment", ...priced.orderFields(input), expiresAt },
        });
        await recordStockChange(runtime, reserved.snapshots, priced.stockItems, "reserve", orderToken, ctx);
      } catch (error) {
        await inventory(ctx.env).cancel(orderToken);
        if (created) await runtime.deleteEntry.execute({ id: created.id, collection: "orders", ctx });
        throw error;
      }
      // 4. schedule expiry; the cron sweep covers a lost message
      const enqueue = ctx.env.ORDER_EXPIRY_QUEUE.send({ type: "expire-order", orderToken }, { contentType: "json", delaySeconds: CHECKOUT_TTL_MS / 1000 })
        .catch((error) => console.error(`[commerce] could not enqueue expiry for ${orderToken}`, error));
      if (ctx.waitUntil) ctx.waitUntil(enqueue); else await enqueue;
      return { outcome: "pending_payment", orderToken, orderNumber: orderNumber(now, orderToken), expiresAt, totalMinor: priced.totalMinor, currency: priced.currency };
    },

    payOrder: async ({ orderToken }, ctx) => {
      const runtime = await getRuntime();
      const order = await runtime.entries.readByDataField({ collection: "orders", field: "orderToken", value: orderToken });
      if (!order) return { outcome: "missing", orderToken };
      const result = await inventory(ctx.env).pay(orderToken, Date.now());
      if (result.outcome === "paid" || result.outcome === "already_paid") {
        await recordStockChange(runtime, result.snapshots ?? [], result.items ?? [], "sale", orderToken, ctx);
        await updateOrder(runtime, order, { orderStatus: "paid", paidAt: order.data.paidAt ?? Date.now() }, ctx); // keep the first paidAt
      } else if (result.outcome === "expired") {
        await expirePersistedOrder(runtime, order, result, ctx);
      }
      return { outcome: result.outcome === "paid" || result.outcome === "already_paid" || result.outcome === "expired" ? result.outcome : "closed", orderToken };
    },

    expireOrder: async ({ orderToken, now }, ctx) => {
      const runtime = await getRuntime();
      const result = await inventory(ctx.env).expire(orderToken, now);
      const order = await runtime.entries.readByDataField({ collection: "orders", field: "orderToken", value: orderToken });
      if (result.outcome === "expired" && order) await expirePersistedOrder(runtime, order, result, ctx);
      return { outcome: result.outcome === "expired" || result.outcome === "too_early" || result.outcome === "missing" ? result.outcome : "closed", orderToken };
    },

    sweepExpiredOrders: async ({ now }, ctx) => {
      const runtime = await getRuntime();
      const pending = await runtime.listEntries.execute({ collection: "orders", filter: { field: "orderStatus", value: "pending_payment" }, limit: 100 });
      let expired = 0;
      for (const order of pending) {
        if ((order.data.expiresAt as number) > now) continue;
        const result = await inventory(ctx.env).expire(order.data.orderToken as string, now);
        if (result.outcome === "expired") { await expirePersistedOrder(runtime, order, result, ctx); expired += 1; }
      }
      return { checked: pending.length, expired };
    },

    adjustInventory: async ({ operationId, productSlug, delta, reason }, ctx) => {
      const runtime = await getRuntime();
      const result = await inventory(ctx.env).adjust(operationId, productSlug, delta, reason);
      if (result.outcome === "idempotency_conflict") throw conflict("/operationId", operationId, "an idempotency key used with the same adjustment input");
      if (result.outcome === "insufficient_stock") throw conflict("/delta", delta, "an adjustment that keeps available stock non-negative");
      await persistSnapshots(runtime, [result.snapshot], ctx);
      await ensureMovement(runtime, `adjust:${operationId}`, { productSlug, kind: "adjust", availableDelta: delta, reservedDelta: 0, note: reason }, ctx);
      return result.snapshot;
    },

    fulfillOrder: async ({ orderToken, trackingNumber }, ctx) => { /* DO fulfill -> updateOrder({ orderStatus: "fulfilled", fulfilledAt, trackingNumber }) */ },
    cancelGuestOrder: async ({ orderToken }, ctx) => { /* only pending_payment; DO cancel -> release movements + updateOrder({ orderStatus: "cancelled", cancelledAt, cancelReason }) */ },
  };
}

function conflict(path: string, value: unknown, expected: string): DiagnosticError {
  return new DiagnosticError(runtimeDiagnostic({ code: "CONFLICT", severity: "error", path, value, expected }));
}
```

`expirePersistedOrder` records `release` movements and deletes the pending order row from the mirror; the audit trail keeps the trace. `persistSnapshots`, `ensureMovement`, `updateOrder` and `recordStockChange` are the revision-guarded and insert-if-absent helpers described above; the retired implementation in Source shows them in full.

### Delayed expiry with Queues and a cron sweep

`place-order` sends `{ type: "expire-order", orderToken }` with `delaySeconds` equal to the checkout TTL. The consumer validates the message before touching the runtime and decides per message:

| Consumer observation | Action | Why |
|---|---|---|
| runtime boot fails | `batch.retryAll()` | nothing was processed |
| malformed body | `ack()` and log | retrying cannot fix it |
| Procedure `ok: false`, code `INTERNAL_ERROR` or `CONFLICT` | `retry()` | transient or racing with pay/cancel |
| Procedure `ok: false`, any other code | `ack()` and log | permanent (for example validation) |
| `outcome: too_early` | `retry({ delaySeconds: 60 })` | delivered before `expiresAt` |
| `outcome: expired`, `closed` or `missing` | `ack()` | terminal |
| handler threw | `retry()` | dispatch failure |

Queue delivery is at-least-once and a delayed message can arrive early, late or twice; the DO makes `expire` idempotent so that is harmless. The `*/5 * * * *` cron runs `sweep-expired-orders`, which lists `pending_payment` rows and expires those past `expiresAt`, so correctness does not depend on any single delivery. Undeliverable messages land in the DLQ after `max_retries`. This queue is application-owned; Mantle's own deferred-hook queue is a separate opt-in described in [Deferred hooks with Queues](../cloudflare/deferred-hooks-queues.md).

### Where the payment provider plugs in

The Manifest above ships `pay-order-http` so the flow can be exercised without a provider. **Remove that Trigger in production.** Knowing an order token must never count as proof of payment.

Provider callbacks do not fit the JSON HTTP Trigger path: Stripe-style webhooks sign the raw request body and reject re-serialized JSON; ECPay-style callbacks post form data and expect a specific acknowledgement body. Mount the callback as an application route in `extend.mount`, as `src/index.ts` above does, on a path outside Mantle's reserved prefixes. In that route:

1. Read the raw body with `c.req.text()` and verify the provider signature with the secret from `Env`. Reject on failure and return before touching Mantle.
2. Map the verified event to an `orderToken` (store it as the provider's client reference when creating the provider session).
3. Invoke the internal `pay-order` Procedure through `bindMantle(await getRuntime()).procedures.payOrder(...)`. Do not call the handler function directly and do not write Mantle tables from the route; the Procedure pipeline and the DO transition stay the single path.
4. Treat every callback as a retry. `pay` returns `already_paid` on repetition, `sale:<orderToken>:<slug>` movement keys are inserted only if absent, and `paidAt` keeps its first value. A duplicate callback therefore cannot deduct inventory twice.
5. Answer the provider with whatever it requires for acknowledgement once the outcome is terminal (`paid`, `already_paid`, `expired`, `closed`, `missing`). Return 5xx only for `INTERNAL_ERROR` so the provider retries.

Provider return and success URLs are customer navigation only; only the verified server callback confirms payment. Before enabling a real provider, make concurrent pay and cancel callbacks converge: a late `paid` projection must not overwrite a cancellation that already restored stock. The DO already refuses to pay a non-pending order; keep the Mantle projection ordered by re-reading the row before each `updateDraft`.

## Try it

Place an order:

```sh
curl -sS -X POST http://localhost:8787/api/commerce/orders \
  -H 'content-type: application/json' \
  -d '{"customerName":"Ada","customerEmail":"ada@example.test","shippingAddress":"1 Shell Lane","items":[{"productSlug":"notebook","quantity":2}]}'
```

```json
{
  "ok": true,
  "data": {
    "outcome": "pending_payment",
    "orderToken": "5b7d1a8e-4c2f-4f7e-9d1a-0b6c2e8f3a11",
    "orderNumber": "MNT-20260910-5B7D1A8E",
    "expiresAt": 1788880263492,
    "totalMinor": 2400,
    "currency": "TWD"
  }
}
```

Insufficient stock is HTTP 409 `CONFLICT` at `path: "/items"`; an unknown slug is HTTP 400 `INPUT_VALIDATION_FAILED`. With the demo Trigger still present, `POST /api/commerce/orders/pay` with `{"orderToken":"..."}` returns `{ ok: true, data: { outcome: "paid", orderToken } }` the first time and `already_paid` after that.

Public catalog:

```sh
curl -sS 'http://localhost:8787/api/views/public-products?show=20'
# {"ok":true,"data":{"rows":[{"id":"...","slug":"notebook","title":"Notebook","priceMinor":1200,"currency":"TWD","updatedAt":...}],"page":1,"show":20,"hasMore":false}}
```

Staff, on `/mcp/staff`:

```json
{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {
    "name": "adjust_inventory",
    "arguments": { "operationId": "0d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6", "productSlug": "notebook", "delta": 50, "reason": "Restock from supplier" }
  }
}
```

The result is the new snapshot `{ productSlug, available, reserved, revision }`. Repeating the exact call returns the same snapshot; changing `delta` while reusing `operationId` is a JSON-RPC error with `error.data.code = "CONFLICT"`. A non-owner staff session is denied with `AUTH_DENIED`.

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `query_view_public_products` | public View |
| `/mcp/staff` | `query_view_picking_list` | staff `sql` View |
| `/mcp/staff` | `adjust_inventory`, `fulfill_order` | staff MCP Triggers |
| `/mcp/staff` | `create_draft_products`, `update_draft_products`, `request_publish`, ... | publishing Schema `products` |

`orders`, `inventory` and `inventory-movements` expose no `create_record_*`/`update_record_*` tools because they are `readOnly`. `expire_order` and `sweep_expired_orders` are not tools anywhere.

## What this deliberately leaves out

- **A real provider SDK.** `verifyProviderEvent` is a placeholder for the chosen provider's signature check.
- **Tax, shipping, discounts.** `totalMinor` equals the sum of line totals.
- **Refunds.** No Procedure moves a `paid` order to refunded; `cancel-order` for staff exists in the retired implementation and returns stock, but it does not move money.
- **Multi-currency carts.** All lines must share one currency; mixed carts are rejected.
- **Sharding the Durable Object.** One instance per shop is the right default. Split by SKU only after measured single-shop saturation, and expect a distributed reservation workflow when you do.
- **Customer accounts.** Orders are guest orders keyed by token; see [Procurement approvals](./procurement-approvals.md) for `ctx.user`-owned rows.

The DO protects local coordination. It is not a distributed transaction across the DO, D1 and the provider; each downstream step must be safe to retry and have a reconciliation path (the sweep, the audit rows, provider retries).

## Source

- [`docs/transaction-patterns.md`](../../../docs/transaction-patterns.md) — reserve/settle exactly once, delayed expiry, adoption checks
- [`docs/design-atoms.md`](../../../docs/design-atoms.md) — `readOnly`, `x-mantle-ref`, `idempotency-key`, `sql` Views
- [`docs/deferred-lifecycle-queues.md`](../../../docs/deferred-lifecycle-queues.md) — Queue contract and multiplexing
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts) — `extend.mount`, `getRuntime`
- [`packages/mantle/src/codegen/emitMantleModule.ts`](../../../packages/mantle/src/codegen/emitMantleModule.ts) — `bindMantle(...).procedures`
- [`overlays/transaction/manifests/site.yaml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/manifests/site.yaml) — retired full Manifest
- [`overlays/transaction/src/index.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/src/index.ts) — queue and scheduled entrypoints
- [`overlays/transaction/src/commerce/handlers.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/src/commerce/handlers.ts) — full handler implementation
- [`overlays/transaction/src/commerce/InventoryCoordinator.ts`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/src/commerce/InventoryCoordinator.ts) — Durable Object
- [`overlays/transaction/wrangler.append.toml`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/wrangler.append.toml)
- [`overlays/transaction/handoff.md`](https://github.com/aotter/mantle-starters/blob/a66ec0ea3aaefc09a0229b7d8ca35af630f2b55d/overlays/transaction/handoff.md) — "Replacing the demo payment"
