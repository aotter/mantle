/**
 * Required application seams. Each entry is a public entry point applications depend on; it must not be removed, moved or
 * narrowed because Core has no internal use. Changing one needs an accepted ADR or ADR-lite and a migration note; new
 * public surface for applications adds an entry, its id in `application-seams.ids.json` and its consumer module in the
 * same PR (CONTRIBUTING.md, "Application seams").
 *
 * `check` is a consumer module (public imports only, no casts) that `application-seams.test.ts` of its package
 * typechecks against the built package on each stack in `stacks` and, unless `run` is false, executes there.
 * `stacks: []`: the seam uses no database and is checked once.
 */

/** The four stacks Mantle commits to. */
export const STACKS = ["cloudflare-d1", "cloudflare-postgres", "bun-postgres", "bun-sqlite"] as const;
export type Stack = (typeof STACKS)[number];

export interface Seam {
  readonly id: string;
  readonly package: "@aotter/mantle" | "@aotter/mantle-admin";
  /** The exports-map key and the names it must export, when the seam is a module export. */
  readonly subpath?: string;
  readonly exports?: readonly string[];
  /** The entry point: a signature, parameter or option. */
  readonly entry: string;
  readonly stacks: readonly Stack[];
  /** The accepted decision that keeps it. */
  readonly decided: string;
  /** The consumer module, from the repository root. */
  readonly check: string;
  /** A stack whose dialect needs its own consumer module. */
  readonly stackChecks?: Partial<Record<Stack, string>>;
  /** false: typechecked only; executed by the test named in `decided`'s change. */
  readonly run?: false;
}

const ALL = STACKS;
const SEAM = "docs/adr/adr-lite-application-seams.md";

export const SEAMS: readonly Seam[] = [
  {
    id: "transaction-handle",
    package: "@aotter/mantle",
    entry: "generated store(db, caller).transaction(fn, options): fn(tx, db)",
    stacks: ["cloudflare-postgres", "bun-postgres", "bun-sqlite"], // D1 has no interactive transaction
    decided: "docs/adr/adr-lite-2015-application-sql-in-transactions.md",
    check: "packages/mantle/tests/seams/transaction.ts",
    stackChecks: { "bun-sqlite": "packages/mantle/tests/seams/transaction-sqlite.ts" },
  },
  {
    id: "json-body",
    package: "@aotter/mantle",
    subpath: "./rest",
    exports: ["body"],
    entry: "body(request, limit?, refuse?)",
    stacks: ALL,
    decided: SEAM,
    check: "packages/mantle/tests/seams/json-body.ts",
  },
  {
    id: "origin-rule-and-errors",
    package: "@aotter/mantle",
    subpath: "./contracts",
    exports: ["checkOrigin", "surfaceFailure", "ContractError"],
    entry: "checkOrigin(request, caller), surfaceFailure(error)",
    stacks: ALL,
    decided: SEAM,
    check: "packages/mantle/tests/seams/origin-rule.ts",
  },
  {
    id: "call-tool",
    package: "@aotter/mantle",
    subpath: "./mcp",
    exports: ["callTool"],
    entry: "callTool(tool, input, db, caller, handlers)",
    stacks: ALL,
    decided: SEAM,
    check: "packages/mantle/tests/seams/call-tool.ts",
  },
  {
    id: "input-conversion",
    package: "@aotter/mantle",
    subpath: "./contracts",
    exports: ["convertInput"],
    entry: "convertInput(input, convert)",
    stacks: ALL,
    decided: SEAM,
    check: "packages/mantle/tests/seams/input-conversion.ts",
  },
  {
    id: "procedure-input",
    package: "@aotter/mantle",
    entry: "generated validation/procedures/<name>.ts input(raw)",
    stacks: ALL,
    decided: SEAM,
    check: "packages/mantle/tests/seams/procedure-input.ts",
  },
  {
    id: "tool-meta",
    package: "@aotter/mantle",
    subpath: "./mcp",
    exports: ["mcp", "withResultMeta"],
    entry: "Tool.meta, withResultMeta(data, meta)",
    stacks: ALL,
    decided: SEAM,
    check: "packages/mantle/tests/seams/tool-meta.ts",
  },
  {
    id: "app-resource-meta",
    package: "@aotter/mantle",
    subpath: "./mcp",
    exports: ["mcp"],
    entry: "McpAppResource.meta",
    stacks: ALL,
    decided: "#1995",
    check: "packages/mantle/tests/seams/resource-meta.ts",
  },
  {
    id: "managed-grant",
    package: "@aotter/mantle",
    subpath: "./auth/oauth",
    exports: ["issueManagedGrant", "oauthGrantExtension"],
    entry: "issueManagedGrant(input, grant), oauthGrantExtension",
    stacks: [],
    decided: "#1998",
    check: "packages/mantle/tests/seams/managed-grant.ts",
    run: false, // executed in tests/auth-caller.test.ts and tests/auth-oauth-postgres.test.ts
  },
  {
    id: "host-tools",
    package: "@aotter/mantle-admin",
    subpath: "./hooks",
    exports: ["useHost"],
    entry: "useHost().registerTools(tools)",
    stacks: [],
    decided: "#2005",
    check: "packages/mantle-admin/test/seams/host-tools.ts",
    run: false, // executed in the Admin MCP App tests
  },
  {
    id: "admin-app-tools",
    package: "@aotter/mantle-admin",
    subpath: "./mcp",
    exports: ["adminMcpApps"],
    entry: "adminMcpApps({ tools })",
    stacks: [],
    decided: "#1969",
    check: "packages/mantle-admin/test/seams/admin-app-tools.ts",
  },
  {
    id: "page-renders-tool",
    package: "@aotter/mantle-admin",
    subpath: "./app",
    exports: ["defineAdmin"],
    entry: "defineAdmin(meta, { pages: [{ mcp: { renders } }] })",
    stacks: [],
    decided: SEAM,
    check: "packages/mantle-admin/test/seams/page-renders.ts",
  },
  {
    id: "mcp-app-inspect",
    package: "@aotter/mantle-admin",
    subpath: "./testing",
    exports: ["checkMcpApp"],
    entry: "checkMcpApp({ catalogue, html, inspect })",
    stacks: [],
    decided: SEAM,
    check: "packages/mantle-admin/test/seams/mcp-app-inspect.ts",
    run: false, // executed in test/testing.test.ts (a browser test)
  },
  {
    id: "upload-card-tool",
    package: "@aotter/mantle-admin",
    subpath: "./mcp",
    exports: ["mediaUploadCard"],
    entry: "mediaUploadCard({ tool, forward, inputTimeoutMs })",
    stacks: [],
    decided: "#1965",
    check: "packages/mantle-admin/test/seams/upload-card.ts",
  },
];
