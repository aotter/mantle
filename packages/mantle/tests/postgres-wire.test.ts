/**
 * The PostgreSQL wire messages Mantle's driver sends through postgres.js, recorded by a TCP proxy. A flight is what the
 * client writes before the server answers, so flights are round trips. `P`/`B` carry `(named)` or `('')` for the
 * statement name: Cloudflare documents that Hyperdrive supports postgres.js's named prepared statements, and says its
 * transaction pooling "does not reliably support" the unnamed describe-first path that `unsafe` takes by default.
 */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { createServer, connect, type AddressInfo } from "node:net";
import postgres from "postgres";
import { procedure, read, run, transaction } from "../src/kernel/driver/postgres.js";

const url = process.env.MANTLE_PG_URL;

async function proxy() {
  const target = new URL(url!);
  let flights: string[] = [],
    answered = true;
  const server = createServer(client => {
    const origin = connect(Number(target.port), target.hostname);
    let started = false,
      buffer = Buffer.alloc(0);
    client.on("data", (data: Buffer) => {
      origin.write(data);
      buffer = Buffer.concat([buffer, data]);
      const types: string[] = [];
      if (!started) {
        // SSLRequest or StartupMessage: no type byte
        started = buffer.readUInt32BE(4) !== 80877103;
        buffer = buffer.subarray(buffer.readUInt32BE(0));
        types.push("Startup");
      }
      while (buffer.length >= 5 && buffer.length > buffer.readUInt32BE(1)) {
        const type = String.fromCharCode(buffer[0]!);
        // Parse starts with the statement name; Bind with the portal name, then the statement name.
        const name = type === "P" ? 5 : type === "B" ? buffer.indexOf(0, 5) + 1 : -1;
        types.push(name < 0 ? type : `${type}${buffer[name] === 0 ? "''" : "(named)"}`);
        buffer = buffer.subarray(buffer.readUInt32BE(1) + 1);
      }
      if (answered) flights.push("");
      flights[flights.length - 1] += types.join("");
      answered = false;
    });
    origin.on("data", data => {
      client.write(data);
      answered = true;
    });
    for (const socket of [client, origin]) {
      socket.on("error", () => {});
      socket.on("close", () => (socket === client ? origin : client).destroy());
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const through = new URL(target);
  through.port = String((server.address() as AddressInfo).port);
  return {
    url: through.toString(),
    /** The flights `fn` sends. */
    async record(fn: () => PromiseLike<unknown>) {
      flights = [];
      await fn();
      return flights;
    },
    close: () => server.close(),
  };
}

const R = "SELECT $1::int + 1 AS x",
  W = "INSERT INTO wire_probe (v) VALUES ($1)";
const first = ["P(named)DH", "B(named)ES"],
  repeated = ["B(named)ES"];

(url ? test : test.skip)(
  "postgres.js: Mantle's reads, writes, Procedures and transactions use named prepared statements",
  async () => {
    const wire = await proxy();
    // The Workers recommendation: a client per request, one connection, no type fetch.
    const sql = postgres(wire.url, { max: 1, fetch_types: false, onnotice: () => {} });
    try {
      await sql.unsafe("CREATE TEMP TABLE wire_probe (v int)");
      // The first use of a statement on a connection describes it (two round trips); later uses bind it (one).
      expect(await wire.record(() => read(sql, R, [1]))).toEqual(first);
      expect(await wire.record(() => read(sql, R, [2]))).toEqual(repeated);
      expect(await wire.record(() => run(sql, W, [1]))).toEqual(first);
      expect(await wire.record(() => run(sql, W, [2]))).toEqual(repeated);
      // A statement without binds stays a simple query.
      expect(await wire.record(() => read(sql, "SELECT 1", []))).toEqual(["Q"]);
      // A two-step Procedure: BEGIN, both steps (already prepared on this connection), then postgres.js's own COMMIT,
      // which it prepares (one flight, no binds) on first use.
      const steps = [
        { sql: W, binds: [3] },
        { sql: R, binds: [3] },
      ];
      expect(await wire.record(() => procedure(sql, steps, "wire"))).toEqual([
        "Q",
        ...repeated,
        ...repeated,
        "P(named)DB(named)ES",
      ]);
      // A Store transaction: Mantle's own statements are prepared; the application's `unsafe` keeps postgres.js's
      // default (unnamed, describe-first) unless it passes `{ prepare: true }` itself.
      const flights = await wire.record(() =>
        transaction(sql, async tx => {
          await read(tx, "SELECT $1::int AS fresh", [4]);
          await tx.unsafe("SELECT $1::int AS app", [5]);
          await tx.unsafe("SELECT $1::int AS app", [6], { prepare: true });
        }),
      );
      expect(flights).toEqual(["Q", ...first, "P''DH", "B''ES", ...first, "B(named)ES"]);
    } finally {
      await sql.end();
      wire.close();
    }
  },
  30000,
);

(url ? test : test.skip)(
  "postgres.js: a client created with prepare: false keeps every statement unnamed",
  async () => {
    const wire = await proxy();
    const sql = postgres(wire.url, { max: 1, fetch_types: false, prepare: false });
    try {
      await sql.unsafe("SELECT 1");
      for (const value of [1, 2]) expect(await wire.record(() => read(sql, R, [value]))).toEqual(["P''DH", "B''ES"]);
    } finally {
      await sql.end();
      wire.close();
    }
  },
  30000,
);

(url ? test : test.skip)(
  "Bun.SQL ignores the option and prepares named statements as before",
  async () => {
    const wire = await proxy();
    const sql = new SQL(wire.url, { max: 1 });
    try {
      await sql.unsafe("SELECT 1");
      // Bun.SQL describes with Sync rather than Flush, and Bun 1.3 adds Flush messages before Sync.
      const flights = [await wire.record(() => read(sql, R, [1])), await wire.record(() => read(sql, R, [2]))];
      expect(flights.map(flight => flight.map(types => types.replaceAll("H", "")))).toEqual([
        ["P(named)DS", "B(named)ES"],
        ["B(named)ES"],
      ]);
    } finally {
      await sql.close();
      wire.close();
    }
  },
  30000,
);
