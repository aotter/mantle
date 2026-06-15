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

    // SELECT … FROM entries WHERE collection = ? [AND status = ?] AND json_extract(data, ?) = ? [...AND id <> ?] ORDER BY updated_at DESC LIMIT 1
    if (
      sql.startsWith("SELECT id, collection, status, version, data, author_id, created_at, updated_at FROM entries") &&
      sql.includes("json_extract(data, ?) = ?")
    ) {
      const hasStatus = sql.includes("AND status = ?");
      const hasExcludeId = sql.includes("AND id <> ?");
      const collection = p[0] as string;
      let pi = 1;
      const status = hasStatus ? (p[pi++] as string) : null;
      const fieldValues: Array<{ field: string; value: unknown }> = [];
      while (pi < p.length - (hasExcludeId ? 1 : 0)) {
        const path = p[pi++] as string;
        const value = p[pi++];
        fieldValues.push({ field: fieldFromJsonPath(path), value });
      }
      const excludeId = hasExcludeId ? (p[p.length - 1] as string) : null;
      const filtered = [...this.db.entries.values()]
        .filter((r) => r.collection === collection)
        .filter((r) => (status ? r.status === status : true))
        .filter((r) => (excludeId ? r.id !== excludeId : true))
        .filter((r) => {
          const data = JSON.parse(r.data) as Record<string, unknown>;
          return fieldValues.every(({ field, value }) => data[field] === value);
        })
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 1);
      return { rows: filtered.map((r) => ({ ...r })), changes: 0 };
    }

    // SELECT … FROM entries WHERE collection = ? [AND status = ?] ORDER BY updated_at DESC LIMIT ?
    if (sql.startsWith("SELECT id, collection, status, version, data, author_id, created_at, updated_at FROM entries WHERE collection = ?")) {
      const hasStatus = sql.includes("AND status = ?");
      const collection = p[0] as string;
      const status = hasStatus ? (p[1] as string) : null;
      const limit = (hasStatus ? (p[2] as number) : (p[1] as number)) ?? 100;
      const filtered = [...this.db.entries.values()]
        .filter((r) => r.collection === collection)
        .filter((r) => (status ? r.status === status : true))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit);
      return { rows: filtered.map((r) => ({ ...r })), changes: 0 };
    }

    // DELETE FROM entries WHERE id = ?
    if (sql.startsWith("DELETE FROM entries WHERE id = ?")) {
      const removed = this.db.entries.delete(p[0] as string);
      return { rows: [], changes: removed ? 1 : 0 };
    }
    // DELETE FROM revisions WHERE entry_id = ?
    if (sql.startsWith("DELETE FROM revisions WHERE entry_id = ?")) {
      const eid = p[0] as string;
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

    // SELECT ... FROM media_assets [WHERE ...] ORDER BY created_at DESC, id DESC LIMIT ?
    if (
      sql.startsWith("SELECT id, created_at, owner_id, alt, caption, variants, metadata FROM media_assets") &&
      sql.includes("ORDER BY created_at DESC, id DESC")
    ) {
      const limit = p[p.length - 1] as number;
      let rows = [...this.db.mediaAssets.values()];
      let index = 0;
      if (sql.includes("id LIKE ?")) {
        const search = likeToIncludes(p[index] as string);
        index += 3;
        rows = rows.filter((r) =>
          r.id.includes(search) ||
          (r.alt ?? "").includes(search) ||
          (r.caption ?? "").includes(search),
        );
      }
      if (sql.includes("(created_at < ? OR (created_at = ? AND id < ?))")) {
        const createdAt = p[index] as number;
        const id = p[index + 2] as string;
        rows = rows.filter((r) => r.created_at < createdAt || (r.created_at === createdAt && r.id < id));
      }
      rows.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
      return { rows: rows.slice(0, limit) as unknown as Record<string, unknown>[], changes: 0 };
    }

    // UPDATE media_assets via DatabaseMediaAssetRepository.save() ON CONFLICT path handles writes.

    // DELETE FROM media_assets WHERE id = ?
    if (sql.startsWith("DELETE FROM media_assets WHERE id = ?")) {
      const id = p[0] as string;
      const had = this.db.mediaAssets.has(id);
      this.db.mediaAssets.delete(id);
      return { rows: [], changes: had ? 1 : 0 };
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

    // Publish read paths — SELECT id, collection, status, version, data, created_at, updated_at FROM entries WHERE …
    if (sql.startsWith("SELECT id, collection, status, version, data, created_at, updated_at FROM entries WHERE")) {
      const tail = sql.slice("SELECT id, collection, status, version, data, created_at, updated_at FROM entries WHERE ".length);
      const limitMatch = tail.match(/ LIMIT (\d+)$/);
      const limit = limitMatch ? Number(limitMatch[1]) : undefined;
      const stripped = limit ? tail.slice(0, tail.length - limitMatch![0].length) : tail;
      const rest = stripped.replace(/ ORDER BY updated_at DESC$/, "");
      const conds = rest.split(" AND ");
      const matchedRows = [...this.db.entries.values()].filter((r) => {
        let pi = 0;
        for (const cond of conds) {
          if (cond === `status = 'published'`) {
            if (r.status !== "published") return false;
          } else if (cond === `status = ?`) {
            if (r.status !== (p[pi++] as string)) return false;
          } else if (cond === `json_extract(data, '$.locale') IS NULL`) {
            const data = JSON.parse(r.data) as Record<string, unknown>;
            if (typeof data["locale"] === "string") return false;
          } else if (cond === `json_extract(data, '$.locale') = ?`) {
            const want = p[pi++] as string;
            const data = JSON.parse(r.data) as Record<string, unknown>;
            if (data["locale"] !== want) return false;
          } else if (cond === `json_extract(data, '$.slug') = ?`) {
            const want = p[pi++] as string;
            const data = JSON.parse(r.data) as Record<string, unknown>;
            if (data["slug"] !== want) return false;
          } else if (cond === `collection = ?`) {
            if (r.collection !== (p[pi++] as string)) return false;
          } else if (/^json_extract\(data, '\$\.[A-Za-z_][A-Za-z0-9_]*'\) IN \(\?(?:, \?)*\)$/.test(cond)) {
            const field = cond.match(/^json_extract\(data, '\$\.([A-Za-z_][A-Za-z0-9_]*)'\) IN /)![1]!;
            const placeholderCount = (cond.match(/\?/g) ?? []).length;
            const wantSet = new Set(p.slice(pi, pi + placeholderCount));
            pi += placeholderCount;
            const data = JSON.parse(r.data) as Record<string, unknown>;
            if (!wantSet.has(data[field] as string)) return false;
          } else {
            throw new Error(`fake DB: unsupported cond '${cond}' in publish read SELECT`);
          }
        }
        return true;
      });
      matchedRows.sort((a, b) => b.updated_at - a.updated_at);
      const capped = limit ? matchedRows.slice(0, limit) : matchedRows;
      return { rows: capped.map((r) => ({ ...r })), changes: 0 };
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

function likeToIncludes(value: string): string {
  return value.replace(/^%|%$/g, "").replace(/\\([\\%_])/g, "$1");
}

function fieldFromJsonPath(path: string): string {
  const quoted = path.match(/^\$."((?:\\.|[^"])*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const dotted = path.match(/^\$\.([^.[\]]+)$/);
  if (dotted) return dotted[1];
  throw new Error(`unsupported json path in fake database: ${path}`);
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
