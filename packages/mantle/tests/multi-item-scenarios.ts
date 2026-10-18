/** One oracle for every target: a multi-line order commits every line or none. Also imported by the local D1 Worker. */
type Query = (sql: string) => Promise<Record<string, unknown>[]>;
const equal = (actual: unknown, expected: unknown, what: string) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };

export const seed = (pg: boolean) => `INSERT INTO products (id, version, created_at, updated_at, name, stock, reserved) VALUES ('pen', 1, ${pg ? "now(), now()" : "0, 0"}, 'pen', 10, 0), ('stapler', 1, ${pg ? "now(), now()" : "0, 0"}, 'stapler', 1, 0);`;

export async function verifyMultiItem(app: (request: Request) => Promise<Response | undefined>, query: Query) {
  const order = (orderRef: string, items: unknown) => app(new Request("http://local/api/orders", { method: "POST", headers: { "content-type": "application/json", "x-role": "user" }, body: JSON.stringify({ orderRef, items }) }));
  const state = async () => ({
    reserved: (await query("SELECT id, reserved FROM products ORDER BY id")).map(row => [row.id, Number(row.reserved)]),
    lines: (await query("SELECT orderref, productid, qty FROM order_lines ORDER BY orderref, productid")).map(row => [row.orderref, row.productid, Number(row.qty)]),
  });
  equal((await order("o1", [{ productId: "pen", qty: 3 }, { productId: "stapler", qty: 1 }]))?.status, 200, "an order within stock");
  const placed = { reserved: [["pen", 3], ["stapler", 1]], lines: [["o1", "pen", 3], ["o1", "stapler", 1]] };
  equal(await state(), placed, "every line reserved and written");
  // The pen line fits; the stapler line oversells. Neither may stay.
  const refused = await order("o2", [{ productId: "pen", qty: 2 }, { productId: "stapler", qty: 1 }]);
  equal(refused?.status, 409, "an order with one oversold line");
  equal(await state(), placed, "the refused order left no reservation and no line");
  // Two lines for the same product add up against the same stock.
  equal((await order("o3", [{ productId: "pen", qty: 4 }, { productId: "pen", qty: 4 }]))?.status, 409, "repeated lines past stock");
  equal(await state(), placed, "repeated lines past stock left nothing");
  // An unknown product leaves matchedLines short of lineCount, so the orders check refuses every line.
  equal((await order("o4", [{ productId: "pen", qty: 1 }, { productId: "missing", qty: 1 }]))?.status, 409, "an order naming an unknown product");
  equal(await state(), placed, "the unknown product left no reservation and no line");
  // orderRef is unique: replaying an order is refused instead of reserving twice.
  equal((await order("o1", [{ productId: "pen", qty: 1 }]))?.status, 409, "a repeated orderRef");
  equal(await state(), placed, "the repeated order left nothing");
  equal((await query("SELECT orderref, linecount, matchedlines FROM orders")).map(row => [row.orderref, Number(row.linecount), Number(row.matchedlines)]), [["o1", 2, 2]], "one order row, every line matched");
}
