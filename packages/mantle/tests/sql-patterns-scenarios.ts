/** One oracle for docs/handbook/guides/sql-patterns.md on every target, through the generated REST boundary (and MCP for the nested JSON read). Also imported by the local D1 Worker. */
type App = (request: Request) => Promise<Response | undefined>;
type Query = (sql: string) => Promise<Record<string, unknown>[]>;
const equal = (actual: unknown, expected: unknown, what: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

export const seed = (pg: boolean) =>
  `INSERT INTO products (id, version, created_at, updated_at, sku, name, note, price, stock, reserved, active) VALUES ('pen', 1, ${pg ? "now(), now()" : "0, 0"}, 'PEN', 'Pen', 'blue', 5, 100, 0, ${pg ? "true" : "1"}), ('desk', 1, ${pg ? "now(), now()" : "0, 0"}, 'DESK', 'Desk', NULL, 3000, 3, 0, ${pg ? "true" : "1"});`;

export async function verifySqlPatterns(app: App, query: Query, pg: boolean) {
  const send = async (path: string, body: unknown, role = "admin", user = "u") => {
    const response = (await app(
      new Request(`http://local${path}`, {
        method: path.startsWith("/api/views/") ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-role": role, "x-user": user },
        ...(path.startsWith("/api/views/") ? {} : { body: JSON.stringify(body) }),
      }),
    ))!;
    return { status: response.status, body: (await response.json()) as any };
  };
  const product = async (id: string) => {
    const [row] = await query(`SELECT name, note, stock, reserved, active, version FROM products WHERE id = '${id}'`);
    return {
      name: row!.name,
      note: row!.note,
      stock: Number(row!.stock),
      reserved: Number(row!.reserved),
      active: Boolean(Number(row!.active)),
      version: Number(row!.version),
    };
  };
  const orderStatus = async (id: string) =>
    (await query(`SELECT orderstatus FROM orders WHERE id = '${id}'`))[0]?.orderstatus;

  // CASE: the status is chosen in the INSERT from catalogue prices, and only a small order reserves stock in the same program.
  const small = await send("/api/orders", { productId: "pen", qty: 10 }, "user");
  equal([small.status, small.body.results[0][0].orderStatus], [200, "reserved"], "an order of 50 is reserved at once");
  const big = await send("/api/orders", { productId: "desk", qty: 2 }, "user");
  equal([big.status, big.body.results[0][0].orderStatus], [200, "pending_approval"], "an order over 5000 waits");
  equal(
    [(await product("pen")).reserved, (await product("desk")).reserved],
    [10, 0],
    "only the small order reserved stock",
  );
  equal(
    (await send("/api/orders", { productId: "pen", qty: 1, unitPrice: 0 }, "user")).status,
    400,
    "the caller cannot send a price",
  );

  // Approve before reserving: the guarded status change and the reservation commit together.
  const bigId = big.body.results[0][0].id;
  equal((await send("/api/orders/approve", { id: bigId, expectedVersion: 99 })).status, 409, "a stale version");
  equal(
    [await orderStatus(bigId), (await product("desk")).reserved],
    ["pending_approval", 0],
    "a stale approval changed nothing",
  );
  equal(
    (await send("/api/orders/approve", { id: bigId, expectedVersion: 1 })).status,
    200,
    "approve the reviewed version",
  );
  equal([await orderStatus(bigId), (await product("desk")).reserved], ["reserved", 2], "approval reserved the stock");
  equal(
    (await send("/api/orders/approve", { id: bigId, expectedVersion: 2 })).status,
    409,
    "an order already approved",
  );
  const over = await send("/api/orders", { productId: "desk", qty: 2 }, "user");
  equal(
    (await send("/api/orders/approve", { id: over.body.results[0][0].id, expectedVersion: 1 })).status,
    409,
    "approving past stock",
  );
  equal(
    [await orderStatus(over.body.results[0][0].id), (await product("desk")).reserved],
    ["pending_approval", 2],
    "the refused approval left the order pending and the stock alone",
  );

  // COALESCE: an omitted field keeps its value; NULLIF treats an empty note as omitted.
  const pen = await product("pen");
  equal(
    (await send("/api/products/update", { id: "pen", expectedVersion: pen.version, name: "Gel pen" })).status,
    200,
    "rename only",
  );
  equal((({ name, note }) => [name, note])(await product("pen")), ["Gel pen", "blue"], "the note was kept");
  equal(
    (await send("/api/products/update", { id: "pen", expectedVersion: pen.version + 1, note: "" })).status,
    200,
    "an empty note",
  );
  equal((({ name, note }) => [name, note])(await product("pen")), ["Gel pen", "blue"], "an empty note kept both");
  equal(
    (await send("/api/products/update", { id: "pen", expectedVersion: pen.version, name: "Stale" })).status,
    409,
    "a stale version",
  );

  // ON CONFLICT DO UPDATE: the first restock creates the product, the next adds to it.
  equal(
    (await send("/api/products/restock", { sku: "TAPE", name: "Tape", price: 2, qty: 5 })).status,
    200,
    "first restock",
  );
  equal(
    (await send("/api/products/restock", { sku: "TAPE", name: "Tape", price: 2, qty: 7 })).status,
    200,
    "second restock",
  );
  equal(
    (await query("SELECT stock FROM products WHERE sku = 'TAPE'")).map(row => Number(row.stock)),
    [12],
    "one row, stock added up",
  );

  // NOT EXISTS: a product with an order awaiting approval cannot be discontinued; one without can.
  equal((await send("/api/products/discontinue", { id: "desk" })).status, 409, "desk has an order awaiting approval");
  equal((await product("desk")).active, true, "desk is still sold");
  const tape = String((await query("SELECT id FROM products WHERE sku = 'TAPE'"))[0]!.id);
  equal((await send("/api/products/discontinue", { id: tape })).status, 200, "tape has no orders");
  equal(
    (await send("/api/orders", { productId: tape, qty: 1 }, "user")).body.results[0],
    [],
    "a discontinued product takes no order",
  );

  // One read for a product and its orders; [] when it has none.
  const nested = await send("/api/views/products-with-orders", undefined);
  equal(nested.status, 200, "products-with-orders");
  // The boundary types a computed JSON document as json: an array on every target, though SQLite and D1 return text.
  const tool = (await app(
    // MCP protocol revision 2026-07-28: the `_meta` envelope and the headers that state it (no SDK in a Worker bundle).
    new Request("http://local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-role": "admin",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "products_with_orders",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "products_with_orders",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  ))!;
  const reply = await tool.text(),
    mcpRows = JSON.parse(reply.startsWith("event:") ? reply.split("data: ")[1]!.split("\n")[0]! : reply).result
      ?.structuredContent?.rows;
  for (const rows of [nested.body.rows, mcpRows]) {
    for (const row of rows ?? [undefined])
      equal(Array.isArray(row?.orders), true, "the nested column is an array over REST and MCP");
    equal(
      rows.map((row: any) => [row.name, row.orders.map((o: { qty: number }) => o.qty).sort()]).sort(),
      [
        ["Desk", [2, 2]],
        ["Gel pen", [10]],
        ["Tape", []],
      ],
      "each product with its orders",
    );
  }

  // row_number: the latest order of each product. Backdate the first desk order so the order of creation is unambiguous.
  await query(
    `UPDATE orders SET created_at = ${pg ? "created_at - interval '1 second'" : "created_at - 1000000"} WHERE id = '${bigId}'`,
  );
  const latest = await send("/api/views/latest-order-per-product", undefined);
  equal(
    latest.body.rows.map((row: any) => [row.productId, row.id]),
    [
      ["desk", over.body.results[0][0].id],
      ["pen", small.body.results[0][0].id],
    ],
    "the latest order per product",
  );

  // onNoRows: conflict: an INSERT ... SELECT that finds no live product writes nothing and is 409 kind "row", where place-order returns [].
  const orders = async () => Number((await query("SELECT count(*) AS n FROM orders"))[0]!.n),
    before = await orders();
  for (const productId of ["no-such-product", tape]) {
    const refused = await send("/api/orders/request", { productId, qty: 1 }, "user");
    equal(
      [refused.status, refused.body.error?.code, refused.body.error?.kind],
      [409, "CONFLICT", "row"],
      `a request for ${productId === tape ? "a discontinued" : "an unknown"} product`,
    );
  }
  equal(await orders(), before, "a refused request wrote no order");
  const requested = await send("/api/orders/request", { productId: "pen", qty: 2 }, "user");
  equal(
    [requested.status, requested.body.results[0].length, await orders()],
    [200, 1, before + 1],
    "a request for a product on sale writes one order",
  );

  await verifyRetries(app, send, query);
}

type Send = (path: string, body: unknown, role?: string, user?: string) => Promise<{ status: number; body: any }>;

/** Retry safely: an idempotent SQL insert (`create-invoice`). */
async function verifyRetries(app: App, send: Send, query: Query) {
  const count = async (table: string, where: string) =>
    Number((await query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);

  // ON CONFLICT DO UPDATE ... WHERE: a replay returns the stored row, a reuse with other values is CONFLICT.
  const invoice = (body: object, user = "u") => send("/api/invoices", body, "user", user);
  const first = await invoice({ operationId: "op-1", customer: "acme", amount: 100 });
  const id = first.body.results?.[0]?.[0]?.id;
  equal([first.status, typeof id], [200, "string"], "the first request creates the invoice");
  const replay = await invoice({ operationId: "op-1", customer: "acme", amount: 100 });
  equal([replay.status, replay.body.results[0][0].id], [200, id], "a replay returns the same invoice");
  const reused = await invoice({ operationId: "op-1", customer: "acme", amount: 999 });
  equal(
    [reused.status, reused.body.error?.code, reused.body.error?.kind, reused.body.error?.step],
    [409, "CONFLICT", "row", "replay"],
    "the same operationId with another amount",
  );
  const elsewhere = await invoice({ operationId: "op-1", customer: "acme", amount: 999 }, "v");
  equal(
    [elsewhere.status, elsewhere.body.results[0][0].id === id],
    [200, false],
    "another caller's operationId is its own",
  );
  equal(
    [
      await count("invoices", "operationid = 'op-1'"),
      Number((await query(`SELECT version FROM invoices WHERE id = '${id}'`))[0]!.version),
      Number((await query(`SELECT amount FROM invoices WHERE id = '${id}'`))[0]!.amount),
    ],
    [2, 2, 100],
    "one row per caller; the replay raised the version and kept the amount",
  );
  const together = await Promise.all([1, 2].map(() => invoice({ operationId: "op-2", customer: "acme", amount: 5 })));
  equal(
    [together.map(r => r.status), together[0]!.body.results[0][0].id, await count("invoices", "operationid = 'op-2'")],
    [[200, 200], together[1]!.body.results[0][0].id, 1],
    "two first requests at once: one row, both get it",
  );
}
