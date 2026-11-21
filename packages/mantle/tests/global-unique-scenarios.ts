/** One oracle for docs/handbook/reference/schema.md#a-value-unique-across-all-owners on every target, through the generated REST boundary. Also imported by the local D1 Worker. */
type App = (request: Request) => Promise<Response | undefined>;
type Query = (sql: string) => Promise<Record<string, unknown>[]>;
const equal = (actual: unknown, expected: unknown, what: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/** Callers: `x-user` is the subject. */
export async function verifyGlobalUnique(app: App, query: Query) {
  const send = async (path: string, body: unknown, user: string) => {
    const response = (await app(
      new Request(`http://local${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": user },
        body: JSON.stringify(body),
      }),
    ))!;
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  const ann = (path: string, body: unknown) => send(path, body, "ann"),
    bob = (path: string, body: unknown) => send(path, body, "bob");
  const registry = async () =>
    (await query("SELECT hostname FROM hostnames ORDER BY hostname")).map(row => row.hostname);
  const domains = async () =>
    (await query("SELECT owner, hostname FROM domains ORDER BY hostname")).map(row => `${row.owner}:${row.hostname}`);

  // Claim: the scoped row and the registry row commit together.
  const claimed = await ann("/api/domains", { hostname: "shop.example" });
  equal(claimed.status, 200, "ann claims shop.example");
  const id = claimed.body.results[0][0].id as string;
  equal([await registry(), await domains()], [["shop.example"], ["ann:shop.example"]], "both rows written");

  // Another owner: CONFLICT kind unique, nothing about the holder, and its scoped insert rolled back.
  const taken = await bob("/api/domains", { hostname: "shop.example" });
  equal([taken.status, taken.body.error?.code, taken.body.error?.kind], [409, "CONFLICT", "unique"], "taken");
  equal(
    ["ann", id].filter(secret => taken.text.includes(secret)),
    [],
    "the refusal names no holder, owner or row",
  );
  equal(await domains(), ["ann:shop.example"], "the refused claim left no scoped row");
  equal((await bob("/api/domains", { hostname: "other.example" })).status, 200, "bob claims another");

  // Rename: a held name is CONFLICT; a stale version is CONFLICT; both leave the registry as it was.
  const heldName = await ann("/api/domains/rename", { id, expectedVersion: 1, hostname: "other.example" });
  equal([heldName.status, heldName.body.error?.kind], [409, "unique"], "rename to a held name");
  const stale = await ann("/api/domains/rename", { id, expectedVersion: 7, hostname: "new.example" });
  equal([stale.status, stale.body.error?.kind], [409, "row"], "rename at a stale version");
  equal(await registry(), ["other.example", "shop.example"], "refused renames changed nothing");
  const renamed = await ann("/api/domains/rename", { id, expectedVersion: 1, hostname: "new.example" });
  equal(renamed.status, 200, "rename to a free name");
  equal(
    [await registry(), await domains()],
    [
      ["new.example", "other.example"],
      ["ann:new.example", "bob:other.example"],
    ],
    "the registry followed the rename, and the old name is free",
  );
  equal((await bob("/api/domains", { hostname: "shop.example" })).status, 200, "the old name is free");

  // Release: only a domain the caller can see; the registry row goes with it.
  const foreign = await bob("/api/domains/release", { id });
  equal([foreign.status, foreign.body.error?.kind], [409, "row"], "bob cannot release ann's domain");
  equal((await registry()).includes("new.example"), true, "a refused release keeps the registry row");
  equal((await ann("/api/domains/release", { id })).status, 200, "ann releases her domain");
  equal(await registry(), ["other.example", "shop.example"], "released");
  equal((await bob("/api/domains", { hostname: "new.example" })).status, 200, "the name is free");
  equal(
    [(await registry()).length, (await domains()).length],
    [3, 3],
    "one registry row per domain after every refusal",
  );
}
