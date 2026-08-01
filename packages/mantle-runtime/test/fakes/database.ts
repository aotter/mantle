import type {
  BatchResult,
  DatabaseDriver,
  Migration,
  MigrationRunner,
  PreparedStatement,
  RunResult,
} from "../../src/domain/port/DatabaseDriver.js";

/**
 * Tiny SQL-aware in-memory `DatabaseDriver`. Pattern-matches the queries
 * the runtime actually emits — not a general SQL engine. Queries
 * outside the supported set throw with the offending SQL so a
 * diverging test is easy to diagnose.
 *
 * Tables modelled: `entries`, `revisions`, `approvals`, `users`,
 * `staff`, `sessions`, `site_config`. Migrations runner records
 * applied ids in a Set; no DDL execution.
 */
interface EntryRecord {
  id: string;
  collection: string;
  status: string;
  version: number;
  data: string;
  author_id: string | null;
  created_at: number;
  updated_at: number;
}
interface StaffRecord {
  user_id: string;
  role: string;
  granted_by: string | null;
  granted_at: number;
}
interface UserRecord {
  id: string;
  email: string | null;
  name: string | null;
  created_at: number;
}

export class InMemoryDatabase implements DatabaseDriver {
  readonly executions: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  entries = new Map<string, EntryRecord>();
  revisions = new Map<string, { entry_id: string }>();
  approvals = new Map<string, { entry_id: string }>();
  staff = new Map<string, StaffRecord>();
  users = new Map<string, UserRecord>();
  siteConfig = new Map<string, string>();
  mediaAssets = new Map<string, {
    id: string;
    created_at: number;
    owner_id: string | null;
    alt: string | null;
    caption: string | null;
    variants: string;
    metadata: string | null;
  }>();
  appliedMigrations = new Set<string>();
  legacyIndexColumns = new Map<string, readonly string[]>();

  prepare(sql: string): PreparedStatement {
    return new InMemoryStatement(this, normalize(sql), []);
  }

  async batch(stmts: ReadonlyArray<PreparedStatement>): Promise<readonly BatchResult[]> {
    const out: BatchResult[] = [];
    for (const s of stmts) {
      const r = await s.run();
      out.push({ success: true, meta: { changes: r.meta.changes } });
    }
    return out;
  }

  migrations: MigrationRunner = {
    runAll: async (migs: ReadonlyArray<Migration>) => {
      for (const m of migs) this.appliedMigrations.add(m.id);
    },
  };

  /** Test seed helpers. */
  _seedUser(u: UserRecord): void {
    this.users.set(u.id, u);
  }
  _seedStaff(s: StaffRecord): void {
    this.staff.set(s.user_id, s);
  }
}

class InMemoryStatement implements PreparedStatement {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly sql: string,
    private readonly params: readonly unknown[],
  ) {}

  bind(...params: ReadonlyArray<unknown>): PreparedStatement {
    return new InMemoryStatement(this.db, this.sql, params);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { rows } = this.execute();
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<readonly T[]> {
    return this.execute().rows as T[];
  }

  async run(): Promise<RunResult> {
    const { changes } = this.execute();
    return { success: true, meta: { changes } };
  }

  private execute(): { rows: Record<string, unknown>[]; changes: number } {
    const sql = this.sql;
    const p = this.params;
    this.db.executions.push({ sql, params: p });

    if (
      sql === "SELECT id FROM _migrations WHERE id LIKE 'schema-unique-index:%'" ||
      sql === "SELECT id FROM _migrations WHERE id LIKE 'schema-index-v2:index:%'"
    ) {
      const prefix = sql.includes("schema-index-v2")
        ? "schema-index-v2:index:"
        : "schema-unique-index:";
      return {
        rows: [...this.db.appliedMigrations]
          .filter((id) => id.startsWith(prefix))
          .map((id) => ({ id })),
        changes: 0,
      };
    }
    const legacyInfo = /^PRAGMA index_info\("([^"]+)"\)$/.exec(sql);
    if (legacyInfo) {
      return {
        rows: (this.db.legacyIndexColumns.get(legacyInfo[1]!) ?? [])
          .map((name, seqno) => ({ name, seqno })),
        changes: 0,
      };
    }
    if (/^DROP INDEX IF EXISTS "(?:m2[ui]_|uq_)/.test(sql)) {
      const indexName = /^DROP INDEX IF EXISTS "([^"]+)"$/.exec(sql)?.[1];
      if (indexName) this.db.legacyIndexColumns.delete(indexName);
      return { rows: [], changes: 0 };
    }
    if (sql === "DELETE FROM _migrations WHERE id = ?") {
      return {
        rows: [],
        changes: this.db.appliedMigrations.delete(p[0] as string) ? 1 : 0,
      };
    }

    // INSERT INTO entries
    if (sql.startsWith("INSERT INTO entries")) {
      const [id, collection, status, data, author_id, created_at, updated_at] = p as [
        string, string, string, string, string | null, number, number,
      ];
      this.db.entries.set(id, {
        id,
        collection,
        status,
        version: 1,
        data,
        author_id,
        created_at,
        updated_at,
      });
      return { rows: [], changes: 1 };
    }

    // SELECT … FROM entries WHERE id = ?
    if (
      sql.startsWith("SELECT id, collection, status, version, data, author_id, created_at, updated_at FROM entries WHERE id = ?") ||
      sql.startsWith("SELECT id, collection, status, version, data, created_at, updated_at FROM entries WHERE id = ?")
    ) {
      const r = this.db.entries.get(p[0] as string);
      return { rows: r ? [r as unknown as Record<string, unknown>] : [], changes: 0 };
    }

    // SELECT status FROM entries WHERE id = ?
    if (sql.startsWith("SELECT status FROM entries WHERE id = ?")) {
      const r = this.db.entries.get(p[0] as string);
      return { rows: r ? [{ status: r.status }] : [], changes: 0 };
    }

    // SELECT version FROM entries WHERE id = ?
    if (sql.startsWith("SELECT version FROM entries WHERE id = ?")) {
      const r = this.db.entries.get(p[0] as string);
      return { rows: r ? [{ version: r.version }] : [], changes: 0 };
    }

    // SELECT version, status FROM entries WHERE id = ? — used by
    // transitionStatus disambiguation (one SELECT covers both checks).
    if (sql.startsWith("SELECT version, status FROM entries WHERE id = ?")) {
      const r = this.db.entries.get(p[0] as string);
      return {
        rows: r ? [{ version: r.version, status: r.status }] : [],
        changes: 0,
      };
    }
    if (sql.startsWith("SELECT collection, status, version FROM entries WHERE id = ?")) {
      const r = this.db.entries.get(p[0] as string);
      return {
        rows: r
          ? [{ collection: r.collection, status: r.status, version: r.version }]
          : [],
        changes: 0,
      };
    }

    // UPDATE entries SET data = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING …
    if (sql.startsWith("UPDATE entries SET data = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING")) {
      const [data, version, updated_at, id, expected] = p as [string, number, number, string, number];
      const r = this.db.entries.get(id);
      if (!r || r.version !== expected) return { rows: [], changes: 0 };
      r.data = data;
      r.version = version;
      r.updated_at = updated_at;
      return { rows: [r as unknown as Record<string, unknown>], changes: 1 };
    }

    // UPDATE entries SET status = 'archived', version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING …
    if (sql.startsWith("UPDATE entries SET status = 'archived', version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING")) {
      const [version, updated_at, id, expected] = p as [number, number, string, number];
      const r = this.db.entries.get(id);
      if (!r || r.version !== expected) return { rows: [], changes: 0 };
      r.status = "archived";
      r.version = version;
      r.updated_at = updated_at;
      return { rows: [r as unknown as Record<string, unknown>], changes: 1 };
    }

    // UPDATE entries SET status = ?, version = version + 1, updated_at = ? WHERE id = ? [AND status = ?] RETURNING …
    if (sql.startsWith("UPDATE entries SET status = ?, version = version + 1, updated_at = ? WHERE id = ?")) {
      const guarded = sql.includes("AND status = ?");
      if (guarded) {
        const [to, updated_at, id, expectedStatus] = p as [string, number, string, string];
        const r = this.db.entries.get(id);
        if (!r || r.status !== expectedStatus) return { rows: [], changes: 0 };
        r.status = to;
        r.version = r.version + 1;
        r.updated_at = updated_at;
        return { rows: [r as unknown as Record<string, unknown>], changes: 1 };
      }
      const [to, updated_at, id] = p as [string, number, string];
      const r = this.db.entries.get(id);
      if (!r) return { rows: [], changes: 0 };
      r.status = to;
      r.version = r.version + 1;
      r.updated_at = updated_at;
      return { rows: [r as unknown as Record<string, unknown>], changes: 1 };
    }

    // EntryReader queries. Keep one matcher for single, batch, and
    // published reads so the fake follows the production read boundary
    // instead of duplicating every emitted SQL shape.
    if (
      sql.startsWith("SELECT id, collection, status, version, data, author_id, created_at, updated_at FROM entries") &&
      sql.includes(" FROM entries WHERE ") &&
      !sql.includes("LIMIT ? OFFSET ?")
    ) {
      return { rows: runEntryReaderQuery(this.db, sql, p), changes: 0 };
    }

    // SELECT … FROM entries WHERE collection = ? [AND status = ?] [AND (id LIKE ... OR data LIKE ...)] ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
    if (
      sql.startsWith("SELECT id, collection, status, version, data, author_id, created_at, updated_at FROM entries WHERE collection = ?") &&
      sql.includes("ORDER BY updated_at DESC, id DESC")
    ) {
      const hasStatus = sql.includes("AND status = ?");
      const hasSearch = sql.includes("id LIKE");
      const collection = p[0] as string;
      let pi = 1;
      const status = hasStatus ? (p[pi++] as string) : null;
      let searchTerm: string | null = null;
      if (hasSearch) {
        searchTerm = p[pi++] as string;
        pi++; // second bound param is the same term (id + data)
      }
      const limit = (p[pi++] as number) ?? 100;
      const offset = (p[pi++] as number) ?? 0;
      const filtered = [...this.db.entries.values()]
        .filter((r) => r.collection === collection)
        .filter((r) => (status ? r.status === status : true))
        .filter((r) => (searchTerm ? matchesLikeSearch(r, searchTerm) : true))
        .sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(offset, offset + limit);
      return { rows: filtered.map((r) => ({ ...r })), changes: 0 };
    }

    // Snapshot-guarded parent delete.
    if (sql.startsWith("DELETE FROM entries WHERE id = ? AND collection = ?")) {
      const [id, collection, status, version] = p as [string, string, string, number];
      const row = this.db.entries.get(id);
      if (
        !row ||
        row.collection !== collection ||
        row.status !== status ||
        row.version !== version
      ) {
        return { rows: [], changes: 0 };
      }
      this.db.entries.delete(id);
      return { rows: [], changes: 1 };
    }
    // Legacy unguarded parent delete used by direct fake fixtures.
    if (sql.startsWith("DELETE FROM entries WHERE id = ?")) {
      const removed = this.db.entries.delete(p[0] as string);
      return { rows: [], changes: removed ? 1 : 0 };
    }
    // DELETE FROM revisions WHERE entry_id = ?
    if (sql.startsWith("DELETE FROM revisions WHERE entry_id = ?")) {
      const eid = p[0] as string;
      if (sql.includes("AND EXISTS") && !snapshotMatches(this.db, p.slice(1))) {
        return { rows: [], changes: 0 };
      }
      let n = 0;
      for (const [k, v] of this.db.revisions) {
        if (v.entry_id === eid) {
          this.db.revisions.delete(k);
          n++;
        }
      }
      return { rows: [], changes: n };
    }
    // DELETE FROM approvals WHERE entry_id = ?
    if (sql.startsWith("DELETE FROM approvals WHERE entry_id = ?")) {
      const eid = p[0] as string;
      if (sql.includes("AND EXISTS") && !snapshotMatches(this.db, p.slice(1))) {
        return { rows: [], changes: 0 };
      }
      let n = 0;
      for (const [k, v] of this.db.approvals) {
        if (v.entry_id === eid) {
          this.db.approvals.delete(k);
          n++;
        }
      }
      return { rows: [], changes: n };
    }

    // INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING
    if (sql.startsWith("INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")) {
      const [key, value] = p as [string, string];
      if (!this.db.siteConfig.has(key)) {
        this.db.siteConfig.set(key, value);
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    // INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
    if (sql.startsWith("INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")) {
      const [key, value] = p as [string, string];
      const changed = this.db.siteConfig.get(key) !== value;
      this.db.siteConfig.set(key, value);
      return { rows: [], changes: changed ? 1 : 0 };
    }
    // SELECT key, value FROM site_config
    if (sql.startsWith("SELECT key, value FROM site_config")) {
      return {
        rows: [...this.db.siteConfig.entries()].map(([key, value]) => ({ key, value })),
        changes: 0,
      };
    }
    // SELECT value FROM site_config WHERE key = ?
    if (sql.startsWith("SELECT value FROM site_config WHERE key = ?")) {
      const key = p[0] as string;
      const v = this.db.siteConfig.get(key);
      return { rows: v !== undefined ? [{ value: v }] : [], changes: 0 };
    }

    // INSERT INTO media_assets (...) ... ON CONFLICT(id) DO UPDATE SET ...
    if (sql.startsWith("INSERT INTO media_assets")) {
      const [id, created_at, owner_id, alt, caption, variants, metadata] = p as [
        string, number, string | null, string | null, string | null, string, string | null,
      ];
      this.db.mediaAssets.set(id, { id, created_at, owner_id, alt, caption, variants, metadata });
      return { rows: [], changes: 1 };
    }

    // SELECT ... FROM media_assets WHERE id = ?
    if (sql.startsWith("SELECT id, created_at, owner_id, alt, caption, variants, metadata FROM media_assets WHERE id = ?")) {
      const r = this.db.mediaAssets.get(p[0] as string);
      return { rows: r ? [r as unknown as Record<string, unknown>] : [], changes: 0 };
    }

    // SELECT ... FROM media_assets WHERE id IN (?, ?, ...)
    if (sql.startsWith("SELECT id, created_at, owner_id, alt, caption, variants, metadata FROM media_assets WHERE id IN")) {
      const ids = new Set(p as string[]);
      const rows = [...this.db.mediaAssets.values()].filter((r) => ids.has(r.id));
      return { rows: rows as unknown as Record<string, unknown>[], changes: 0 };
    }

    // DELETE FROM media_assets WHERE id = ?
    if (sql.startsWith("DELETE FROM media_assets WHERE id = ?")) {
      const id = p[0] as string;
      const had = this.db.mediaAssets.has(id);
      this.db.mediaAssets.delete(id);
      return { rows: [], changes: had ? 1 : 0 };
    }

    // SELECT ... FROM media_assets [WHERE (id/alt/caption LIKE ...)]
    //   ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?  (#434 list)
    if (
      sql.startsWith("SELECT id, created_at, owner_id, alt, caption, variants, metadata") &&
      sql.includes("FROM media_assets") &&
      sql.includes("ORDER BY created_at DESC, id DESC")
    ) {
      const hasSearch = sql.includes("id LIKE");
      // Binds: [term, term, term]? , limit, offset
      const offset = p[p.length - 1] as number;
      const limit = p[p.length - 2] as number;
      const term = hasSearch ? String(p[0]) : null;
      let rows = [...this.db.mediaAssets.values()];
      if (term !== null) {
        const needle = unescapeLike(term).toLowerCase();
        rows = rows.filter((r) =>
          r.id.toLowerCase().includes(needle) ||
          (r.alt ?? "").toLowerCase().includes(needle) ||
          (r.caption ?? "").toLowerCase().includes(needle),
        );
      }
      rows.sort((a, b) =>
        b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
      const windowed = rows.slice(offset, offset + limit);
      return { rows: windowed as unknown as Record<string, unknown>[], changes: 0 };
    }

    // SELECT user_id, role, granted_by, granted_at FROM staff WHERE user_id = ?
    if (sql.startsWith("SELECT user_id, role, granted_by, granted_at FROM staff WHERE user_id = ?")) {
      const r = this.db.staff.get(p[0] as string);
      return { rows: r ? [r as unknown as Record<string, unknown>] : [], changes: 0 };
    }
    // SELECT s.user_id, s.role, u.email, u.name FROM staff s INNER JOIN users u ON u.id = s.user_id WHERE s.user_id = ?
    if (sql.startsWith("SELECT s.user_id, s.role, u.email, u.name FROM staff s INNER JOIN users u ON u.id = s.user_id WHERE s.user_id = ?")) {
      const userId = p[0] as string;
      const s = this.db.staff.get(userId);
      const u = this.db.users.get(userId);
      if (!s || !u) return { rows: [], changes: 0 };
      return {
        rows: [{ user_id: s.user_id, role: s.role, email: u.email, name: u.name }],
        changes: 0,
      };
    }

    // View-compiled SELECT: starts with SELECT and FROM entries WHERE collection = ? …
    if (sql.startsWith("SELECT") && sql.includes("FROM entries") && sql.includes("WHERE collection = ?")) {
      return { rows: runCompiledViewQuery(this.db, sql, p), changes: 0 };
    }

    throw new Error(`fake DB: unsupported SQL: ${sql}`);
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function snapshotMatches(db: InMemoryDatabase, values: readonly unknown[]): boolean {
  const [id, collection, status, version] = values as [string, string, string, number];
  const row = db.entries.get(id);
  return row?.collection === collection && row.status === status && row.version === version;
}

/** Mirrors `(id LIKE '%'||?||'%' ESCAPE '\' OR data LIKE '%'||?||'%' ESCAPE '\')`
 *  against the in-memory store: unescape the caller's LIKE-escaped
 *  term back to a literal substring and check `id`/`data` for it. */
function matchesLikeSearch(row: EntryRecord, escapedTerm: string): boolean {
  const literal = unescapeLike(escapedTerm);
  return row.id.includes(literal) || row.data.includes(literal);
}

/** Reverse the `ESCAPE '\'` LIKE-escaping the repos apply to search
 *  terms, recovering the literal substring to match against. */
function unescapeLike(escapedTerm: string): string {
  return escapedTerm
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\\\/g, "\\");
}

function fieldFromJsonPath(path: string): string {
  const quoted = path.match(/^\$."((?:\\.|[^"])*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const dotted = path.match(/^\$\.([^.[\]]+)$/);
  if (dotted) return dotted[1];
  throw new Error(`unsupported json path in fake database: ${path}`);
}

function runEntryReaderQuery(
  db: InMemoryDatabase,
  sql: string,
  params: readonly unknown[],
): Record<string, unknown>[] {
  const whereStart = sql.indexOf(" WHERE ") + " WHERE ".length;
  const orderStart = sql.indexOf(" ORDER BY ", whereStart);
  const limitStart = sql.indexOf(" LIMIT ", whereStart);
  const whereEnd = [orderStart, limitStart, sql.length]
    .filter((index) => index >= 0)
    .reduce((left, right) => Math.min(left, right));
  const conditions = sql.slice(whereStart, whereEnd).split(" AND ");
  const predicates: Array<(row: EntryRecord) => boolean> = [];
  let paramIndex = 0;

  for (const condition of conditions) {
    if (condition === "collection = ?") {
      const expected = params[paramIndex++];
      predicates.push((row) => row.collection === expected);
      continue;
    }
    if (condition === "status = ?") {
      const expected = params[paramIndex++];
      predicates.push((row) => row.status === expected);
      continue;
    }
    if (condition === "status = 'published'") {
      predicates.push((row) => row.status === "published");
      continue;
    }
    if (condition === "id <> ?") {
      const excluded = params[paramIndex++];
      predicates.push((row) => row.id !== excluded);
      continue;
    }

    let field: string | null = null;
    let operation = condition;
    if (condition.startsWith("json_extract(data, ?)")) {
      field = fieldFromJsonPath(String(params[paramIndex++]));
      operation = condition.slice("json_extract(data, ?)".length);
    } else {
      const generated = /^"m2c_[0-9a-f]+_([0-9a-f]+)_[0-9a-f]+"/.exec(condition);
      if (generated) {
        field = decodeHex(generated[1]!);
        operation = condition.slice(generated[0].length);
      }
    }
    if (field === null) {
      throw new Error(`fake DB: unsupported EntryReader condition '${condition}'`);
    }
    if (operation === " IS NULL") {
      predicates.push((row) => readEntryDataField(row, field) == null);
      continue;
    }
    if (operation === " = ?") {
      const expected = params[paramIndex++];
      predicates.push((row) => readEntryDataField(row, field) === expected);
      continue;
    }
    if (/^ IN \(\?(?:, \?)*\)$/.test(operation)) {
      const count = (operation.match(/\?/g) ?? []).length;
      const expected = new Set(params.slice(paramIndex, paramIndex + count));
      paramIndex += count;
      predicates.push((row) => expected.has(readEntryDataField(row, field)));
      continue;
    }
    throw new Error(`fake DB: unsupported EntryReader operation '${operation}'`);
  }

  const rows = [...db.entries.values()].filter((row) =>
    predicates.every((predicate) => predicate(row))
  );
  if (orderStart >= 0) {
    const orderEnd = limitStart >= 0 ? limitStart : sql.length;
    const order = sql.slice(orderStart + " ORDER BY ".length, orderEnd);
    rows.sort((left, right) =>
      right.updated_at - left.updated_at ||
      (order.includes("id DESC")
        ? left.id < right.id ? 1 : left.id > right.id ? -1 : 0
        : 0)
    );
  }
  const limit = limitStart >= 0
    ? Number(sql.slice(limitStart + " LIMIT ".length).split(" ")[0])
    : rows.length;
  return rows.slice(0, limit).map((row) => ({ ...row }));
}

function readEntryDataField(row: EntryRecord, field: string): unknown {
  return (JSON.parse(row.data) as Record<string, unknown>)[field];
}

function decodeHex(value: string): string {
  const bytes = value.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * Runs a compiled View SELECT against the in-memory store. Supports
 * the projection + filter shapes the View compiler emits — reserved
 * columns, `json_extract(data, '$.field')` extraction, comparison
 * filters combined with AND/OR.
 */
function runCompiledViewQuery(
  db: InMemoryDatabase,
  sql: string,
  params: readonly unknown[],
): Record<string, unknown>[] {
  const fromIdx = sql.indexOf(" FROM entries");
  const projection = sql.slice("SELECT".length, fromIdx).trim();
  const afterFrom = sql.slice(fromIdx + " FROM entries".length).trim();
  // afterFrom: WHERE collection = ? [AND (filter)] [ORDER BY …] LIMIT N OFFSET M
  const whereIdx = afterFrom.indexOf("WHERE ");
  const limitIdx = afterFrom.lastIndexOf(" LIMIT ");
  const offsetIdx = afterFrom.lastIndexOf(" OFFSET ");
  const orderIdx = afterFrom.indexOf(" ORDER BY ");
  const whereTail = afterFrom.slice(
    whereIdx + "WHERE ".length,
    orderIdx >= 0 ? orderIdx : limitIdx,
  );
  const orderClause = orderIdx >= 0
    ? afterFrom.slice(orderIdx + " ORDER BY ".length, limitIdx)
    : null;
  const limitEnd = offsetIdx > limitIdx ? offsetIdx : afterFrom.length;
  const limit = parseInt(afterFrom.slice(limitIdx + " LIMIT ".length, limitEnd).trim(), 10);
  const offset =
    offsetIdx > limitIdx
      ? parseInt(afterFrom.slice(offsetIdx + " OFFSET ".length).trim(), 10)
      : 0;

  // collection = ? is always first; everything after AND is a filter.
  const collectionMatch = whereTail.match(/^collection = \?/);
  if (!collectionMatch) throw new Error(`fake DB: view query missing collection: ${sql}`);
  const collection = params[0] as string;
  const remaining = whereTail.slice("collection = ?".length).trim();
  const filterExpr = remaining.startsWith("AND ")
    ? remaining.slice("AND ".length).trim()
    : "";

  // Pre-collect the positional param each atom consumes so per-row
  // eval is a pure read — sharing a mutable counter across rows would
  // off-the-end on the second row.
  const matchFilter = (row: EntryRecord, expr: string): boolean => {
    if (!expr) return true;
    const ctx = { atomIndex: 0 };
    return evalExpr(row, expr.replace(/^\((.*)\)$/, "$1"), ctx);
  };

  const atomParams = collectAtomParams(filterExpr, params, 1);

  const evalExpr = (
    row: EntryRecord,
    expr: string,
    ctx: { atomIndex: number },
  ): boolean => {
    let cleaned = expr.trim();
    while (cleaned.startsWith("(") && matchClose(cleaned, 0) === cleaned.length - 1) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    const top = splitTopLevel(cleaned);
    if (top.op === "AND") return top.parts.every((part) => evalExpr(row, part, ctx));
    if (top.op === "OR") return top.parts.some((part) => evalExpr(row, part, ctx));
    return evalAtom(row, cleaned, ctx);
  };

  const evalAtom = (
    row: EntryRecord,
    atom: string,
    ctx: { atomIndex: number },
  ): boolean => {
    const comparisonMatch = atom.match(/^(.+?)\s*(=|>=|<=|>|<)\s*\?$/);
    if (!comparisonMatch) throw new Error(`fake DB: unsupported atom '${atom}'`);
    const lhs = comparisonMatch[1]!.trim();
    const op = comparisonMatch[2]!;
    const value = atomParams[ctx.atomIndex++];
    return compareValues(readValue(row, lhs), op, value);
  };

  const filtered = [...db.entries.values()]
    .filter((r) => r.collection === collection)
    .filter((r) => matchFilter(r, filterExpr));

  if (orderClause) {
    const parts = orderClause.split(",").map((s) => s.trim());
    filtered.sort((a, b) => {
      for (const part of parts) {
        const m = part.match(/^(.+?)\s+(ASC|DESC)$/i) ?? [null, part, "ASC"];
        const fieldExpr = String(m[1]).trim();
        const direction = String(m[2] ?? "ASC").toUpperCase();
        const av = readValue(a, fieldExpr);
        const bv = readValue(b, fieldExpr);
        if (av === bv) continue;
        const cmp = (av as number | string) > (bv as number | string) ? 1 : -1;
        return direction === "DESC" ? -cmp : cmp;
      }
      return 0;
    });
  }

  return filtered.slice(offset, offset + limit).map((r) => projectRow(r, projection));
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  if (op === "=") return left === right;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  switch (op) {
    case ">":
      return (left as number | string) > (right as number | string);
    case ">=":
      return (left as number | string) >= (right as number | string);
    case "<":
      return (left as number | string) < (right as number | string);
    case "<=":
      return (left as number | string) <= (right as number | string);
    default:
      throw new Error(`fake DB: unsupported comparison operator '${op}'`);
  }
}

function readValue(row: EntryRecord, ref: string): unknown {
  if (ref === "id") return row.id;
  if (ref === "status") return row.status;
  if (ref === "version") return row.version;
  if (ref === "created_at") return row.created_at;
  if (ref === "updated_at") return row.updated_at;
  if (ref === "author_id") return row.author_id;
  // Accept both legacy `$.field` and quoted `$."field"` forms (the
  // compiler always emits the quoted form post-PR14; legacy form
  // kept for any straggling hand-written SQL in this harness).
  const key = parseJsonExtractKey(ref);
  if (key !== null) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    return data[key];
  }
  throw new Error(`fake DB: unsupported field ref '${ref}'`);
}

function parseJsonExtractKey(ref: string): string | null {
  const quoted = ref.match(/^json_extract\(data, '\$\."(.+)"'\)$/);
  if (quoted) return quoted[1]!.replace(/''/g, "'");
  const bare = ref.match(/^json_extract\(data, '\$\.([^'"]+)'\)$/);
  return bare ? bare[1]! : null;
}

function projectRow(row: EntryRecord, projection: string): Record<string, unknown> {
  const parts = projection.split(",").map((s) => s.trim());
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    if (part === "id") out["id"] = row.id;
    else if (part === "status") out["status"] = row.status;
    else if (part === "version") out["version"] = row.version;
    else if (part === "created_at AS createdAt") out["createdAt"] = row.created_at;
    else if (part === "updated_at AS updatedAt") out["updatedAt"] = row.updated_at;
    else if (part === "author_id AS authorId") out["authorId"] = row.author_id;
    else if (part === "data") out["data"] = row.data;
    else {
      // Match either `json_extract(data, '$.<bare>')` or
      // `json_extract(data, '$."<quoted>"')` aliased as `"<name>"`.
      const aliasMatch = part.match(/^json_extract\(data, ('(?:[^']|'')*')\) AS "([^"]+)"$/);
      if (aliasMatch) {
        const key = parseJsonExtractKey(`json_extract(data, ${aliasMatch[1]!})`);
        if (key === null) throw new Error(`fake DB: unsupported view projection part '${part}'`);
        const data = JSON.parse(row.data) as Record<string, unknown>;
        out[aliasMatch[2]!] = data[key];
      } else {
        throw new Error(`fake DB: unsupported view projection part '${part}'`);
      }
    }
  }
  return out;
}

function collectAtomParams(
  expr: string,
  params: readonly unknown[],
  startAt: number,
): unknown[] {
  if (!expr) return [];
  let count = 0;
  for (const ch of expr) {
    if (ch === "?") count++;
  }
  return params.slice(startAt, startAt + count) as unknown[];
}

function matchClose(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a SQL expression at the top-level AND or OR. Handles nested
 * parens: `a AND (b OR c)` → AND parts `["a", "(b OR c)"]`.
 */
function splitTopLevel(expr: string): { op: "AND" | "OR" | null; parts: string[] } {
  const tokens = tokenizeBoolean(expr);
  if (tokens.opCount === 0) return { op: null, parts: [expr] };
  if (tokens.hasAnd && tokens.hasOr) {
    // Mixed at top level isn't emitted by the compiler, but if it were
    // the compiler parenthesises one side. Fall through as AND for
    // pragmatic test coverage — extend if a real test fails.
    return { op: "AND", parts: tokens.parts };
  }
  return { op: tokens.hasAnd ? "AND" : "OR", parts: tokens.parts };
}

function tokenizeBoolean(expr: string): {
  opCount: number;
  hasAnd: boolean;
  hasOr: boolean;
  parts: string[];
} {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let opCount = 0;
  let hasAnd = false;
  let hasOr = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0) {
      if (expr.startsWith(" AND ", i)) {
        parts.push(cur);
        cur = "";
        i += 4;
        opCount++;
        hasAnd = true;
        continue;
      }
      if (expr.startsWith(" OR ", i)) {
        parts.push(cur);
        cur = "";
        i += 3;
        opCount++;
        hasOr = true;
        continue;
      }
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return { opCount, hasAnd, hasOr, parts };
}
