# Portable storage dump and restore

Generation emits a separate `transfer.ts` deployment module. Its `exportStore(db)`
returns a native `ReadableStream<Uint8Array>`; `importStore(db, stream)` returns the
verified imported row count. The library entry `@aotter/mantle-next/transfer`
accepts native read/write/transaction callbacks and the generated constant table
descriptor. It does not load a RuntimePlan, compiler, Store policy or request
router. Applications that do not import this deployment module bundle none of it.

The operator pauses **all** writes, including background jobs and identity/Admin
writes, before exporting. The SDK does not freeze, provision, switch bindings,
upload media objects or manage a rollback window. Pre-provision a fresh target
using the matching generated DDL. Do not apply the generated site seed to that
target: existing seed rows count as a non-empty database and are refused. Keep
the source available until verification and the operator's binding switch finish.

The version-1 format is one UTF-8 NDJSON stream. A header identifies the format,
source SDK version/dialect and SHA-256 fingerprint of the target-independent
portable table/column/key descriptor. Every table section has ordered row arrays
and an ending row count plus checksum; the final footer marks the whole dump
complete. SHA-256 covers canonical JSON row lines (object keys sorted, array order
retained). This detects accidental corruption; it is not authentication of an
untrusted operator. The initial format requires an exact portable descriptor,
not automatic additive-schema conversion.

All physical Schema rows are exported, including other owners, expired rows,
drafts and archived content. Public ids, scope, versions, author and system
timestamps are kept. `_rid`, FTS/RTree indexes and engine scratch tables are not
portable data; the target regenerates them. `site_config` pages by its `key`,
while content/media and configured Better Auth models page by their native ids.
Media metadata is transferred; media object bytes remain operator-owned storage.

Declared integers are exact decimal strings **in this dump format only**. SQL
casts them to text before D1 can round int64 values. Restore binds text to native
integer columns, without converting it through a JS number. This leaves normal
bare query output contracts unchanged. Content timestamps use ISO UTC with six
digits (SQLite microseconds ↔ PostgreSQL timestamptz), dates use `YYYY-MM-DD`;
Better Auth's SQLite ISO timestamps preserve their fraction; media epochs remain
millisecond integers. Booleans are portable values. JSON columns are canonical
JSON **text strings** inside the dump: native numeric tokens keep their exact
decimal digits and use normalized decimal exponents, independently of JavaScript
binary64. Object keys are sorted; arrays and scalar types are retained. JSON
literal `null` remains distinct from SQL NULL. Duplicate object keys are refused
(including keys equal after escape decoding), because PostgreSQL JSONB would
discard them. A native runtime without JSON numeric source/raw-JSON support is
refused; JSON values the target cannot represent never report a completed import.

The exporter retains one 20-row native page. Parsing is incremental, each NDJSON
line is capped at 1 MiB, JSON nesting at 64 levels; imports batch at most 20 rows
and 100 native bind parameters. Descriptor mismatch and any existing target row
are refused before inserts. Import verifies each table's incoming count/hash
and re-reads the restored values to verify them again. SQLite/PostgreSQL import
uses a native transaction; uncertain COMMIT remains `OUTCOME_UNKNOWN`. D1 has no
whole-import transaction: a failure after attempted inserts is `IMPORT_INCOMPLETE`
with `{ incomplete: true }`. Discard that target before retrying, and never switch
bindings after a failed import. A partial/truncated dump cannot report completion.

Better Auth tables follow its configured names, fields and FK order. **Sessions
are not moved**, so members and session-bound MCP bearer clients must authenticate
again. Users, accounts, JWKS, OAuth clients/consents and other configured rows are
retained. Nullable references to omitted sessions with `ON DELETE SET NULL` are
projected as `null`, exactly matching deletion semantics; the header lists these
ignored session links. Required/non-SET-NULL session references are refused.
Counts/hashes describe this portable projection, not bit-identical raw auth rows.
Keep the identity encryption secret and auth options unchanged so retained keys
remain usable. Roles are retained verbatim; an operator upgrading old
owner/editor/contributor data to the `staff` vocabulary applies a separate explicit
role migration. Dump/import never promotes users or changes privileges.

The thin CLI accepts a generated module, an application-owned driver module
exporting `db` and optional `dispose`, and a filename or `-` for standard IO:

```sh
mantle export generated/transfer.js source-driver.js backup.ndjson
mantle import generated/transfer.js target-driver.js backup.ndjson
```

Use emitted JavaScript with Node 22.14. Compile `transfer.ts` with the application's
existing TypeScript/esbuild build (no minification is required); Bun can load the
TypeScript module directly. Driver modules own connections and credentials:

```js
// PostgreSQL: use the application's installed native client, not an SDK dependency.
import postgres from "postgres";
export const db = postgres(process.env.DATABASE_URL);
export const dispose = () => db.end();
```

For Bun SQLite, export a caller-owned `new Database(filename)` from `bun:sqlite`
and dispose it with `close()`. D1 bindings must be supplied by the application's
Worker or its authorized driver module; the Node CLI does not open a live D1
binding or provision cloud resources implicitly. Export files are exclusive
(`wx`) and private (`0600`); an existing backup is never overwritten. Standard
output contains only NDJSON. Native connection/SQL failures are reported with a
fixed safe message, not credentials or dump contents. Protect dump files as you
would protect the original database, and keep this module off public HTTP/MCP
routes.

The driver must support the source/target's native schema features. Node 22.14's
built-in SQLite lacks FTS5; use Bun SQLite or an application-supplied compatible
driver for searchable Schemas. UUID identity mode requires canonical lowercase
UUIDs. Transfer keys use binary text order rather than the database's locale
collation, so the portable checksum ordering stays identical across targets.
