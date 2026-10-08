/**
 * A TCP proxy in front of PostgreSQL that counts round trips and can add latency. A round trip is a client write answered by
 * the server: each run of server bytes that follows client bytes counts once, however the kernel splits either side.
 */
import net from "node:net";

export interface RoundTripProxy {
  readonly url: string;
  /** Round trips per connection, in the order connections were opened; the first of each is the startup handshake. */
  readonly trips: number[];
  close(): Promise<void>;
}

export async function roundTripProxy(target: URL, oneWayMs = 0): Promise<RoundTripProxy> {
  const trips: number[] = [];
  const delay = (f: () => void) => (oneWayMs ? setTimeout(f, oneWayMs) : f());
  const server = net.createServer((client) => {
    const i = trips.push(0) - 1;
    let lastFromClient = false;
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    // as node-postgres does: a pipelined batch is several small writes, which Nagle would hold for a delayed ACK
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on("data", (b) => { lastFromClient = true; delay(() => upstream.write(b)); });
    upstream.on("data", (b) => { if (lastFromClient) trips[i]!++; lastFromClient = false; delay(() => client.write(b)); });
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
