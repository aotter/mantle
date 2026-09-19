---
description: A product catalog and guest orders using only builtin create and update. No Durable Object, Queue, payment provider, or ref handlers.
---
# Commerce catalog and orders

**Handler class:** builtin · **Builder:** yes · [Examples hub](./README.md). Stock authority, Queue expiry, and a verified payment callback are [Commerce inventory](./cf-primitives-commerce-inventory.md).

This example publishes products, lists them publicly, accepts guest orders with builtin `create`, and lets staff mark orders fulfilled or cancelled with builtin `update`. Every Procedure is `handler.kind: builtin`. It does not re-price lines, reserve stock, or talk to a payment provider.

## Problem

Staff publish products with a price. A guest places an order by sending customer fields, an order number, currency, a total, and line items. Staff see submitted orders and record fulfillment or cancellation. Mantle stores the catalog and the order rows. There is no inventory authority in this Manifest.

## Manifest

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
  description: Guest orders created and updated only by declared builtin Procedures.
  lifecycle: operational
  uniqueIndexes:
    - [orderNumber]
  indexes:
    - [orderStatus]
  searchableFields: [orderNumber, customerName, customerEmail]
  schema:
    type: object
    additionalProperties: false
    required: [orderNumber, orderStatus, currency, totalMinor, customerName, customerEmail, shippingAddress, items, placedAt]
    properties:
      orderNumber: { type: string, minLength: 1, maxLength: 40 }
      orderStatus: { type: string, enum: [submitted, fulfilled, cancelled] }
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
          additionalProperties: false
          required: [productSlug, title, quantity, unitPriceMinor, lineTotalMinor]
          properties:
            productSlug: { type: string, pattern: "^[a-z0-9-]+$" }
            title: { type: string }
            quantity: { type: integer, minimum: 1, maximum: 99 }
            unitPriceMinor: { type: integer, minimum: 0 }
            lineTotalMinor: { type: integer, minimum: 0 }
      trackingNumber: { type: string, maxLength: 120 }
      cancelReason: { type: string, maxLength: 500 }
      placedAt: { type: number, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: public-products
spec:
  title: Public products
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
  name: submitted-orders
spec:
  title: Submitted orders
  surface: staff
  from: orders
  fields: [id, version, orderNumber, orderStatus, customerName, customerEmail, shippingAddress, totalMinor, currency, placedAt]
  filter:
    eq: { field: orderStatus, value: submitted }
  orderBy:
    - { field: placedAt, direction: asc }
  limit: 100
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: place-order
spec:
  title: Place order
  input:
    type: object
    additionalProperties: false
    required: [orderNumber, orderStatus, currency, totalMinor, customerName, customerEmail, shippingAddress, items]
    properties:
      orderNumber: { type: string, minLength: 1, maxLength: 40 }
      orderStatus: { type: string, enum: [submitted] }
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
          additionalProperties: false
          required: [productSlug, title, quantity, unitPriceMinor, lineTotalMinor]
          properties:
            productSlug: { type: string, pattern: "^[a-z0-9-]+$" }
            title: { type: string }
            quantity: { type: integer, minimum: 1, maximum: 99 }
            unitPriceMinor: { type: integer, minimum: 0 }
            lineTotalMinor: { type: integer, minimum: 0 }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: orders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: review-order
spec:
  title: Review order
  requires:
    auth:
      all:
        - { "ctx.staff": [owner, editor] }
  input:
    type: object
    additionalProperties: false
    required: [id, expectedVersion, orderStatus]
    properties:
      id: { type: string }
      expectedVersion: { type: number, minimum: 1 }
      orderStatus: { type: string, enum: [fulfilled, cancelled] }
      trackingNumber: { type: string, maxLength: 120 }
      cancelReason: { type: string, maxLength: 500 }
  output: { type: object }
  handler: { kind: builtin, op: update, schema: orders }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: place-order-http
spec:
  source: { kind: http, method: POST, path: /api/commerce/orders }
  target: { procedure: place-order }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: place-order-mcp
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: place-order }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: review-order-mcp
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: review-order }
```

Points worth noticing:

- `products` is a publishing Schema. Staff draft and publish through Admin or Staff MCP generic lifecycle tools. The public View filters `status: published`.
- `orders` is operational. `place-order` is builtin `create`; `review-order` is builtin `update` with `id` and `expectedVersion` required. `placedAt` is server-stamped.
- `orderStatus` on create is narrowed to `submitted`, so this Procedure cannot insert a fulfilled row. Staff `review-order` can only move a row to `fulfilled` or `cancelled`.
- Line titles, unit prices and `totalMinor` are caller-supplied. This Manifest does not re-price from `products` and does not reserve stock.
- `review-order` does not set `x-mantle-ref` on `id`. Drive reviews from `submitted-orders` (which exposes `id` and `version`) through Staff MCP or Admin operations. A lone `[orderNumber]` unique index would otherwise make Admin prefill `id` with the order number; see [Procurement approvals](./builtin-procurement.md).

## Worker and handlers

None. Both Procedures are builtin:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

Sign-in for staff review is the conventional Worker's Auth; see [Authentication](../handbook/cloudflare/authentication.md). The [local Admin OTP host](./host-local-admin-otp/README.md) is the opt-in Dev UI path.

## Try it

Public catalog:

```sh
curl -sS 'http://localhost:8787/api/views/public-products?show=20'
```

Place an order (the body is stored as sent; the server does not re-price):

```sh
curl -sS -X POST http://localhost:8787/api/commerce/orders \
  -H 'content-type: application/json' \
  -d '{"orderNumber":"MNT-20260919-1","orderStatus":"submitted","currency":"TWD","totalMinor":2400,"customerName":"Ada","customerEmail":"ada@example.test","shippingAddress":"1 Shell Lane","items":[{"productSlug":"notebook","title":"Notebook","quantity":2,"unitPriceMinor":1200,"lineTotalMinor":2400}]}'
```

The response is `{ ok: true, data: <EntryRow> }` with `collection: "orders"` and `status: "published"`. A duplicate `orderNumber` is HTTP 409 `CONFLICT`. `orderStatus` other than `submitted` is HTTP 400 `INPUT_VALIDATION_FAILED`.

Staff, on `/mcp/staff`, read `query_view_submitted_orders` then:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "review_order",
    "arguments": { "id": "ord_01j...", "expectedVersion": 1, "orderStatus": "fulfilled", "trackingNumber": "TEST-1" }
  }
}
```

A second reviewer replaying `expectedVersion: 1` receives `CONFLICT`. A contributor-role session is denied with `AUTH_DENIED`.

| Surface | Tool | Origin |
|---|---|---|
| `/mcp` | `query_view_public_products` | public View |
| `/mcp` | `place_order` | `place-order-mcp` Trigger |
| `/mcp/staff` | `query_view_submitted_orders` | staff View |
| `/mcp/staff` | `review_order` | staff MCP Trigger |
| `/mcp/staff` | `create_draft_products`, `update_draft_products`, `request_publish`, ... | publishing Schema `products` |
| `/mcp/staff` | `create_record_orders`, `update_record_orders` | operational Schema `orders` |

## What this deliberately leaves out

- **Stock authority.** There is no `inventory` Schema and no Durable Object. Two orders for the last unit both succeed. That story is [Commerce inventory](./cf-primitives-commerce-inventory.md).
- **Re-pricing.** `totalMinor` and line totals are whatever the caller sent.
- **Payments.** `submitted` is not `pending_payment`. There is no provider callback and no `pay-order` Procedure.
- **Queue expiry and cron.** Unpaid reservation release does not apply; there is no reservation.
- **Picking-list SQL View.** `submitted-orders` is a declared View over `orders`. The `json_each` picking list lives on the cf-primitives page.

Related: [Publication](./builtin-publication.md) for localized product copy; [Procurement approvals](./builtin-procurement.md) for `ctx.user`-owned rows and OCC updates.

## Source

- [Commerce inventory](./cf-primitives-commerce-inventory.md) — DO stock, Queue expiry, payment callback
- [Schema](../handbook/reference/schema.md), [Procedure](../handbook/reference/procedure.md), and [View](../handbook/reference/view.md) references — publishing vs operational, builtin `create`/`update`
- [`host-local-admin-otp`](./host-local-admin-otp/README.md) — opt-in Admin host for publishing products
