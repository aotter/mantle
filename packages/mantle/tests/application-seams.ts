/**
 * Application seams: public entry points that exist on purpose for hand-written application code, beyond mounting the
 * generated modules. Each is a compatibility promise. Removing, moving or narrowing one needs an accepted decision (ADR
 * or ADR-lite) and a migration note; adding public surface for applications adds an entry here and a consumer check in
 * the same PR (CONTRIBUTING.md, "Application seams").
 *
 * `check` is a hand-written application module (public imports only, no casts) that `application-seams.test.ts` of its
 * package typechecks against the built package on each stack in `stacks` and, unless `run` is false, executes there.
 * `stacks: []` marks a seam with no database: it is checked once and behaves the same on every stack.
 * `application-seams.ids.json` pins the ids: removing one fails the tests until the snapshot changes in review too.
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
  /** The entry point as an application writes it. */
  readonly entry: string;
  /** What it lets an application do, in one generic sentence. */
  readonly capability: string;
  readonly stacks: readonly Stack[];
  /** The accepted decision (ADR, ADR-lite, issue or handbook section) that keeps it. */
  readonly decided: string;
  /** The hand-written consumer module, from the repository root. */
  readonly check: string;
  /** A stack whose dialect needs its own module for the same capability. */
  readonly stackChecks?: Partial<Record<Stack, string>>;
  /** false: typechecked only; its behaviour is tested elsewhere (named in `decided` or a comment). */
  readonly run?: false;
}

export const SEAMS: readonly Seam[] = [
  {
    id: "transaction-handle",
    package: "@aotter/mantle",
    entry: "generated store(db, caller).transaction(fn, options): fn(tx, db), db the transaction's native handle",
    capability: "An application runs its own SQL and generated Procedures in one transaction.",
    // D1 has no interactive transaction.
    stacks: ["cloudflare-postgres", "bun-postgres", "bun-sqlite"],
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
    capability: "An application reads a size-limited JSON object body on its own route, with its own error.",
    stacks: STACKS,
    decided: "docs/adr/adr-lite-application-seams.md",
    check: "packages/mantle/tests/seams/own-route.ts",
  },
  {
    id: "origin-rule-and-errors",
    package: "@aotter/mantle",
    subpath: "./contracts",
    exports: ["checkOrigin", "surfaceFailure", "ContractError"],
    entry: "checkOrigin(request, caller), surfaceFailure(error)",
    capability: "An application's own route applies the generated surfaces' cookie-origin rule and error envelope.",
    stacks: STACKS,
    decided: "docs/handbook/reference/surface.md#mcp-catalogue-and-callbacks",
    check: "packages/mantle/tests/seams/own-route.ts",
  },
  {
    id: "call-tool",
    package: "@aotter/mantle",
    subpath: "./mcp",
    exports: ["callTool"],
    entry: "callTool(tool, input, db, caller, handlers)",
    capability:
      "An application calls a generated tool (its validation, input conversion and operation) without the MCP transport.",
    stacks: STACKS,
    decided: "docs/adr/adr-lite-application-seams.md",
    check: "packages/mantle/tests/seams/own-route.ts",
  },
  {
    id: "input-conversion",
    package: "@aotter/mantle",
    subpath: "./contracts",
    exports: ["convertInput"],
    entry: "convertInput(input, convert)",
    capability:
      "A host that calls generated functions directly applies the same input conversions as the generated surfaces.",
    stacks: STACKS,
    decided: "docs/adr/adr-lite-application-seams.md",
    check: "packages/mantle/tests/seams/direct-call.ts",
  },
  {
    id: "own-tools",
    package: "@aotter/mantle",
    subpath: "./mcp",
    exports: ["mcp", "withResultMeta"],
    entry: "Tool.meta, withResultMeta(data, meta), mcp([...tools, own], options)",
    capability: "An application serves its own MCP tools, with listed and result metadata, beside the generated ones.",
    stacks: STACKS,
    decided: "docs/handbook/guides/mcp-apps.md#tool-metadata-and-result-_meta",
    check: "packages/mantle/tests/seams/own-tools.ts",
  },
  {
    id: "app-resource-meta",
    package: "@aotter/mantle",
    subpath: "./mcp",
    exports: ["mcp"],
    entry: "McpAppResource.meta (apps option of mcp(...))",
    capability: "An application serves its own MCP App resource with host metadata.",
    stacks: STACKS,
    decided: "#1995, docs/handbook/guides/mcp-apps.md",
    check: "packages/mantle/tests/seams/own-tools.ts",
  },
  {
    id: "managed-grant",
    package: "@aotter/mantle",
    subpath: "./auth/oauth",
    exports: ["issueManagedGrant", "oauthGrantExtension"],
    entry: "oauthProvider extensions: issueManagedGrant(input, grant)",
    capability: "An application issues tokens for an OAuth extension grant without a consent screen.",
    // Better Auth's own tables; run-time behaviour is tested in tests/auth-caller.test.ts and auth-oauth-postgres.test.ts.
    stacks: [],
    decided: "#1998, docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md",
    check: "packages/mantle/tests/seams/managed-grant.ts",
    run: false,
  },
  {
    id: "host-tools",
    package: "@aotter/mantle-admin",
    subpath: "./hooks",
    exports: ["useHost"],
    entry: "useHost().registerTools(tools)",
    capability: "An application page in the Admin MCP App registers its own app tools.",
    stacks: [],
    decided: "#2005, docs/handbook/guides/native-admin.md",
    check: "packages/mantle-admin/test/seams/host-tools.ts",
    // a React hook in a host; its behaviour is tested in the Admin MCP App tests
    run: false,
  },
  {
    id: "admin-app-tools",
    package: "@aotter/mantle-admin",
    subpath: "./mcp",
    exports: ["adminMcpApps"],
    entry: "adminMcpApps({ tools })",
    capability: "The Admin MCP App renders the results of an application's own tools and Procedures.",
    stacks: [],
    decided: "#1969",
    check: "packages/mantle-admin/test/seams/mcp-apps.ts",
  },
  {
    id: "upload-card-tool",
    package: "@aotter/mantle-admin",
    subpath: "./mcp",
    exports: ["mediaUploadCard"],
    entry: "mediaUploadCard({ media, tool, forward, inputTimeoutMs })",
    capability: "A host that serves media under its own tool shows the upload card for that tool.",
    stacks: [],
    decided: "#1965, docs/adr/adr-lite-application-seams.md",
    check: "packages/mantle-admin/test/seams/mcp-apps.ts",
  },
];
