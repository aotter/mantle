---
description: A published product catalog and guest orders written by SQL Procedures, with an optimistic-lock staff review. No stock authority, payments or handler code.
---
# Commerce catalog and orders

[Examples hub](./README.md) · Stock authority, re-pricing on the server and a verified payment callback are [Commerce inventory](./commerce-inventory.md).

Staff publish products, the public lists them, guests place orders, and staff
mark orders fulfilled or cancelled. Every Procedure is SQL. The example does
not reserve stock or talk to a payment provider.

## Problem

Staff publish products with a price. A guest places an order with customer
fields, an order number, a currency, a total and line items. Staff see
submitted orders and record fulfillment or cancellation. Two staff members must
not overwrite each other's review.

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
      slug: { type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }
      title: { type: string, minLength: 1, maxLength: 160 }
      summary: { type: string, maxLength: 500 }
      priceMinor: { type: integer, minimum: 0, x-mcp-hint: money-minor }
      currency: { type: string, pattern: "^[A-Z]{3}$" }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  description: Guest orders, written only by the declared Procedures.
  lifecycle: operational
  uniqueIndexes: [[orderNumber]]
  indexes: [[orderStatus]]
  searchableFields: [orderNumber, customerName, customerEmail]
  schema:
    type: object
    additionalProperties: false
    required: [orderNumber, orderStatus, currency, totalMinor, customerName, customerEmail, shippingAddress, items]
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
            productSlug: { type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }
            title: { type: string }
            quantity: { type: integer, minimum: 1, maximum: 99 }
            unitPriceMinor: { type: integer, minimum: 0 }
            lineTotalMinor: { type: integer, minimum: 0 }
      trackingNumber: { type: string, maxLength: 120 }
      cancelReason: { type: string, maxLength: 500 }
---
# A public View over a publishing Schema sees published rows only; the SQL does not repeat it.
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: public-products }
spec:
  title: Public products
  surface: public
  sql: |
    SELECT id, slug, title, summary, priceMinor, currency, updated_at
    FROM products
    ORDER BY slug LIMIT 100
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: submitted-orders }
spec:
  title: Submitted orders
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  sql: |
    SELECT id, version, orderNumber, customerName, customerEmail, shippingAddress, totalMinor, currency, created_at
    FROM orders
    WHERE orderStatus = 'submitted'
    ORDER BY created_at LIMIT 100
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: place-order }
spec:
  title: Place order
  description: Record a guest order as submitted.
  input:
    type: object
    additionalProperties: false
    required: [orderNumber, currency, totalMinor, customerName, customerEmail, shippingAddress, items]
    properties:
      orderNumber: { type: string, minLength: 1, maxLength: 40 }
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
            productSlug: { type: string, maxLength: 120, pattern: "^[a-z0-9-]+$" }
            title: { type: string }
            quantity: { type: integer, minimum: 1, maximum: 99 }
            unitPriceMinor: { type: integer, minimum: 0 }
            lineTotalMinor: { type: integer, minimum: 0 }
  output: { type: object }
  handler:
    sql: |
      INSERT INTO orders (orderNumber, orderStatus, currency, totalMinor, customerName, customerEmail, shippingAddress, items)
      VALUES (input.orderNumber, 'submitted', input.currency, input.totalMinor, input.customerName,
              input.customerEmail, input.shippingAddress, input.items)
      RETURNING id, orderNumber AS "orderNumber"
---
# The version predicate is the optimistic lock: a stale expectedVersion matches no row, which is a CONFLICT.
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: review-order }
spec:
  title: Review order
  description: Mark a submitted order fulfilled or cancelled, with the version the reviewer saw.
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  input:
    type: object
    additionalProperties: false
    required: [id, expectedVersion, orderStatus]
    properties:
      id: { type: string }
      expectedVersion: { type: integer, minimum: 1 }
      orderStatus: { type: string, enum: [fulfilled, cancelled] }
      trackingNumber: { type: string, maxLength: 120 }
      cancelReason: { type: string, maxLength: 500 }
  output: { type: object }
  handler:
    sql: |
      UPDATE orders
      SET orderStatus = input.orderStatus,
          trackingNumber = COALESCE(input.trackingNumber, trackingNumber),
          cancelReason = COALESCE(input.cancelReason, cancelReason)
      WHERE id = input.id AND version = input.expectedVersion AND orderStatus = 'submitted'
      RETURNING id, version, orderStatus AS "orderStatus"
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
metadata: { name: place-order-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: place-order }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: review-order-mcp }
spec:
  source: { kind: mcp, surface: staff }
  target: { procedure: review-order }
```

Points worth noticing:

- **`products` is `publishing`.** Staff create drafts and publish through
  Admin's API (`POST /admin/api/entries`, then
  `POST /admin/api/entries/{id}/publish`). SQL cannot set `status`, so
  publishing is never a Procedure's `UPDATE`.
- **The order status on create is a literal.** `place-order` writes
  `'submitted'` itself, so no caller can insert a fulfilled order.
- **`review-order` is a locked row op.** `WHERE id = … AND version = …` pins
  one row, and a row op that writes nothing is `CONFLICT`. Its `target`
  (`orders`, `id`, `expectedVersion`) is inferred from that `WHERE`.
  `COALESCE` keeps a field the caller left out. The extra
  `orderStatus = 'submitted'` means a reviewed order cannot be reviewed again.
- **Line titles, unit prices and the total are what the caller sent.** This
  example does not re-price or reserve stock.

## Handlers

None.

## Try it

```sh
curl -sS 'http://127.0.0.1:8787/api/views/public-products?limit=20'

curl -sS -X POST http://127.0.0.1:8787/api/commerce/orders \
  -H 'content-type: application/json' \
  -d '{"orderNumber":"MNT-20261001-1","currency":"TWD","totalMinor":2400,"customerName":"Ada","customerEmail":"ada@example.test","shippingAddress":"1 Shell Lane","items":[{"productSlug":"notebook","title":"Notebook","quantity":2,"unitPriceMinor":1200,"lineTotalMinor":2400}]}'
```

A duplicate `orderNumber` is HTTP 409 `CONFLICT`. Staff, on `/mcp/staff`,
call `submitted_orders` and then:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "review_order", "arguments": { "id": "<order id>", "expectedVersion": 1, "orderStatus": "fulfilled", "trackingNumber": "TEST-1" } }
}
```

A second reviewer replaying `expectedVersion: 1` gets `CONFLICT`. A
contributor gets `AUTH_DENIED`.

| MCP surface | Tool | From |
|---|---|---|
| `/mcp` | `public_products` | the public View |
| `/mcp` | `place_order` | the `place-order-mcp` Trigger |
| `/mcp/staff` | `submitted_orders` | the staff View |
| `/mcp/staff` | `review_order` | the `review-order-mcp` Trigger |

## What this leaves out

- **Stock authority.** Two orders for the last unit both succeed. See
  [Commerce inventory](./commerce-inventory.md).
- **Re-pricing.** The total is whatever the caller sent.
- **Payments.** `submitted` is not `pending_payment`, and there is no provider
  callback.

## Source

- [Schema](../handbook/reference/schema.md), [View](../handbook/reference/view.md) and [Procedure](../handbook/reference/procedure.md) references
- [Lifecycle and locales](../handbook/concepts/lifecycle-and-locales.md): `publishing` and `operational`
