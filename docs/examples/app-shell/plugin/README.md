# Optional portable plugin metadata

AGENT: replace the plugin identity and `https://example.invalid/mcp` with this
application's deployed endpoint before packaging. Keep credentials out of these
files. Package `plugin.json` and `mcp.json` at the archive root.

OpenAI's [MCP authentication configuration](https://developers.openai.com/plugins/build/plugins#oauth-configuration-reference)
supports `extensions.com.openai.auth.baseScopes` in **each MCP server entry**.
This requests explicit background consent without asking the installer to type
scope names. It is connection configuration, not an extension to the server's
OAuth discovery document or an API scope floor. Use it only when the provider
allows `offline_access` and background access is intended.

Portable package support and custom URL connector setup are different host
paths. An uploaded package that only offers “Open in desktop app” has not
established a working ChatGPT web connection. Verify the actual intended host,
requested consent, token issuance, visible App and post-expiry renewal; do not
claim a successful package upload as web-host acceptance. For a URL-only
connection, follow the installed OAuth guide's separately tested setup.
