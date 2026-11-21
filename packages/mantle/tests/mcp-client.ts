/** The official MCP client in protocol revision 2026-07-28 mode, the one revision Core serves. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_REVISION } from "./mcp-wire.js";

/** The official client in 2026-07-28 mode, connected through `handle`. */
export async function mcpClient(
  handle: (request: Request, env: unknown) => Promise<Response | undefined | null> | Response | undefined | null,
  url = "https://app.test/mcp",
  {
    name = "test",
    version = "1",
    capabilities,
    headers = {},
  }: { name?: string; version?: string; capabilities?: object; headers?: Record<string, string> } = {},
): Promise<Client> {
  const client = new Client(
    { name, version },
    { versionNegotiation: { mode: { pin: MCP_REVISION } }, ...(capabilities ? { capabilities } : {}) },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (target, init) => {
        const request = new Request(String(target), init);
        for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
        return (await handle(request, {}))!;
      },
    }),
  );
  return client;
}
