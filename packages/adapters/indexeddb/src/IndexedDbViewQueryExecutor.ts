import {
  DiagnosticError,
  isCtxUserRef,
  isParamRef,
  runtimeDiagnostic,
  type FilterAst,
} from "@aotter/mantle-spec";
import {
  clampPage,
  clampShow,
  type EntryRow,
  type LogicalViewPlan,
  type RuntimePlan,
  type ViewQueryExecutor,
  type ViewQueryRequest,
  type ViewQueryResult,
} from "@aotter/mantle-runtime";
import type { IndexedDbEntryRepository } from "./IndexedDbEntryRepository.js";

type PreparedView = Extract<LogicalViewPlan, { readonly kind: "declarative" }>;

export class IndexedDbViewQueryExecutor implements ViewQueryExecutor {
  private readonly views = new Map<string, PreparedView>();

  constructor(
    private readonly entries: IndexedDbEntryRepository,
    plan: RuntimePlan,
  ) {
    for (const view of Object.values(plan.views)) {
      if (view.query.kind === "native") {
        throw new DiagnosticError(runtimeDiagnostic({
          code: "VIEW_DIALECT_UNSUPPORTED",
          severity: "error",
          path: `manifest:View/${view.name}#/spec/sql`,
          value: view.query.dialect,
          expected: "a declarative View",
        }));
      }
      this.views.set(view.name, view.query);
    }
  }

  async execute<R = Record<string, unknown>>(
    request: ViewQueryRequest,
  ): Promise<ViewQueryResult<R>> {
    const prepared = this.views.get(request.view);
    if (!prepared) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "NOT_FOUND",
        severity: "error",
        path: `manifest:View/${request.view}`,
        value: request.view,
        expected: "a View in the prepared RuntimePlan",
      }));
    }

    // ponytail: first slice scans one adapter-owned store; add an index planner
    // only when the recorded browser baseline becomes a real product bottleneck.
    let rows = (await this.entries.allRows(prepared.from))
      .filter((row) => !prepared.filter || matchesFilter(
        row,
        prepared.filter,
        request.params ?? {},
        request.ctxUserId,
      ))
      .filter((row) => matchesSearch(row, request.search))
      .filter((row) => (request.filters ?? []).every(
        ({ field, value }) => String(fieldValue(row, field)) === value,
      ));
    rows = prepared.orderBy.length > 0
      ? rows.sort((a, b) => compareOrder(a, b, prepared.orderBy))
      : rows.sort((a, b) => compareValue(a.id, b.id));

    const page = clampPage(request.page);
    const show = clampShow(request.show, prepared.limit);
    const offset = Math.min((page - 1) * show, Number.MAX_SAFE_INTEGER);
    const selected = rows.slice(offset, offset + show);
    return {
      rows: selected.map((row) => projectRow(row, prepared.fields)) as R[],
      page,
      show,
      hasMore: selected.length === show,
    };
  }
}

function matchesFilter(
  row: EntryRow,
  node: FilterAst,
  params: Readonly<Record<string, unknown>>,
  ctxUserId: string | undefined,
): boolean {
  const comparison = comparisonNode(node);
  if (comparison) {
    const expected = resolveFilterValue(comparison.value, params, ctxUserId);
    const actual = fieldValue(row, comparison.field);
    if (comparison.op === "eq") return actual === expected;
    const order = compareUnknown(actual, expected);
    if (comparison.op === "gt") return order > 0;
    if (comparison.op === "gte") return order >= 0;
    if (comparison.op === "lt") return order < 0;
    return order <= 0;
  }
  if ("and" in node) {
    return node.and.every((child) => matchesFilter(row, child, params, ctxUserId));
  }
  return ("or" in node ? node.or : []).some(
    (child) => matchesFilter(row, child, params, ctxUserId),
  );
}

function comparisonNode(node: FilterAst): {
  readonly op: "eq" | "gt" | "gte" | "lt" | "lte";
  readonly field: string;
  readonly value: unknown;
} | null {
  if ("eq" in node) return { op: "eq", ...node.eq };
  if ("gt" in node) return { op: "gt", ...node.gt };
  if ("gte" in node) return { op: "gte", ...node.gte };
  if ("lt" in node) return { op: "lt", ...node.lt };
  if ("lte" in node) return { op: "lte", ...node.lte };
  return null;
}

function resolveFilterValue(
  value: unknown,
  params: Readonly<Record<string, unknown>>,
  ctxUserId: string | undefined,
): unknown {
  if (isCtxUserRef(value)) {
    if (!ctxUserId) {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "UNAUTHENTICATED",
        severity: "error",
        path: "indexeddb/view/filter",
        expected: "ctx.user.id for an identity-bound View filter",
        message: "View filter requires ctx.user.id.",
      }));
    }
    return ctxUserId;
  }
  if (isParamRef(value)) {
    const resolved = params[value.$param];
    if (resolved === undefined) throw new Error(`View filter requires param '${value.$param}'.`);
    return resolved;
  }
  return value;
}

function matchesSearch(
  row: EntryRow,
  search: ViewQueryRequest["search"],
): boolean {
  const term = search?.term.trim().toLowerCase();
  if (!term || !search?.fields.length) return true;
  return search.fields.some((field) =>
    String(fieldValue(row, field) ?? "").toLowerCase().includes(term));
}

function compareOrder(
  a: EntryRow,
  b: EntryRow,
  orderBy: readonly { readonly field: string; readonly direction: "asc" | "desc" }[],
): number {
  for (const order of orderBy) {
    const compared = compareUnknown(fieldValue(a, order.field), fieldValue(b, order.field));
    if (compared !== 0) return order.direction === "desc" ? -compared : compared;
  }
  return compareValue(a.id, b.id);
}

function compareUnknown(a: unknown, b: unknown): number {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  if ((typeof a === "string" && typeof b === "string") ||
    (typeof a === "number" && typeof b === "number")) {
    return compareValue(a, b);
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return compareValue(Number(a), Number(b));
  }
  return compareValue(String(a), String(b));
}

function compareValue(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fieldValue(row: EntryRow, field: string): unknown {
  if (field === "id") return row.id;
  if (field === "status") return row.status;
  if (field === "version") return row.version;
  if (field === "createdAt") return row.createdAt;
  if (field === "updatedAt") return row.updatedAt;
  if (field === "authorId") return row.authorId;
  return row.data[field];
}

function projectRow(
  row: EntryRow,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  const selected = fields ?? [
    "id",
    "status",
    "version",
    "createdAt",
    "updatedAt",
    "authorId",
  ];
  return Object.fromEntries(selected.map((field) => [field, fieldValue(row, field)]));
}
