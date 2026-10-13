# Size and startup

The SDK ships kernel, CLI, generator and private compiler together. Request modules do not import compiler code. Import only selected generated operations and bindings; direct operations can omit Store/Admin/auth entirely.

Workers use `mantle bundle` to emit split ESM. Keep Better Auth behind `authLoader(() => import(...))`; the startup graph guard rejects eager auth imports. The official MCP SDK and selected Admin operations load on matching requests. Generated module imports perform no SQL or kernel initialization; Store metadata initializes on first use without SQL.

Contributor checks use tracked fixtures to compare runtime/startup graphs against `size-budgets.json` and inspect the published allowlist in `check:package`. Package packed/unpacked bytes are reported separately from request startup and query costs. Do not infer latency from bundle bytes.

Cloudflare startup_time_ms needs an actual upload/deployment; offline dry runs do not measure it. Measure on the selected host and report first use and warm work separately. Applications own deployment authorization and resources.
