/** The official MCP client, connected in either era Core serves. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCP_REVISION, type Era } from "./mcp-wire.js";

/**
 * The official client connected through `handle`: in 2026-07-28 mode by default, or with `era` a 2025 revision in its
 * default legacy mode (`initialize`, then stateless requests).
 */
export async function mcpClient(
  handle: (request: Request, env: unknown) => Promise<Response | undefined | null> | Response | undefined | null,
  url = "https://app.test/mcp",
  {
    name = "test",
    version = "1",
    capabilities,
    headers = {},
    era = MCP_REVISION,
  }: { name?: string; version?: string; capabilities?: object; headers?: Record<string, string>; era?: Era } = {},
): Promise<Client> {
  const client = new Client(
    { name, version },
    {
      ...(era === MCP_REVISION ? { versionNegotiation: { mode: { pin: MCP_REVISION } } } : {}),
      ...(capabilities ? { capabilities } : {}),
    },
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
