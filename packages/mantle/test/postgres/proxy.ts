/**
 * A TCP proxy in front of PostgreSQL that counts round trips and can add latency. A round trip is a client write answered by
 * the server: each run of server bytes that follows client bytes counts once, however the kernel splits either side. The
 * startup handshake is not counted: it ends at the server's first ReadyForQuery, one round trip with trust authentication
 * and three with SCRAM (CI's server uses a password).
 */
import net from "node:net";

export interface RoundTripProxy {
  readonly url: string;
  /** Round trips per connection after its startup handshake, in the order connections were opened. */
  readonly trips: number[];
  close(): Promise<void>;
}

const READY = Buffer.from([0x5a, 0, 0, 0, 5]);

export async function roundTripProxy(target: URL, oneWayMs = 0): Promise<RoundTripProxy> {
  const trips: number[] = [];
  const delay = (f: () => void) => (oneWayMs ? setTimeout(f, oneWayMs) : f());
  const server = net.createServer((client) => {
    const i = trips.push(0) - 1;
    let lastFromClient = false;
    let ready = false;
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    // as node-postgres does: a pipelined batch is several small writes, which Nagle would hold for a delayed ACK
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on("data", (b) => { lastFromClient = true; delay(() => upstream.write(b)); });
    upstream.on("data", (b) => {
      // ReadyForQuery is 'Z', length 5, and a status byte; until the first, the server is still authenticating the client
      if (!ready) ready = b.includes(READY);
      else if (lastFromClient) trips[i]!++;
      lastFromClient = false;
      delay(() => client.write(b));
    });
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on("close", end).on("error", end);
    upstream.on("close", end).on("error", end);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as net.AddressInfo).port);
  return { url: url.toString(), trips, close: () => new Promise((r) => server.close(() => r())) };
}
