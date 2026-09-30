/** View.spec and Procedure.spec: input, cache, handler binding, and the `requires` authorization predicate. */
import type { DiagnosticCode } from "../../kernel/diagnostic.js";
import { PROCEDURE_MCP_ANNOTATION_KEYS, PROCEDURE_TARGET_KEYS, STAFF_ROLES, VIEW_INPUT_RESERVED, isStaffRole, type AuthPredicate, type JsonSchema, type ProcedureManifest, type ViewManifest } from "../model/ManifestGrammar.js";
import { ManifestParseError, V01_VIEW_SURFACES, rejectUnknownKeys, validateLocalizedText } from "./ManifestFieldChecks.js";
import { checkFormUiSchema, checkViewAdminUi } from "./SchemaAdminUiChecker.js";
import { validateJsonSchema } from "./SchemaSpecChecks.js";

export function validateViewSpec(m: ViewManifest, idx: number): ViewManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(
    s,
    ["title", "description", "uiSchema", "sql", "surface", "cache", "requires", "input"],
    idx,
    "/spec",
  );
  validateLocalizedText(s["title"], idx, "/spec/title", "View.spec.title", false);
  validateLocalizedText(s["description"], idx, "/spec/description", "View.spec.description", false);
  // Only the SQL compiler (compilePlan) reads the statement; here it just has to be present.
  if (typeof s["sql"] !== "string" || s["sql"].trim().length === 0) {
    throw new ManifestParseError("View.spec.sql is required (one SELECT statement)", idx, "/spec/sql");
  }
  const surface = s["surface"];
  if (typeof surface !== "string" || !V01_VIEW_SURFACES.has(surface)) {
    throw new ManifestParseError(
      `View.spec.surface is required and must be one of ${[...V01_VIEW_SURFACES].join(", ")}; got ${JSON.stringify(surface)}`,
      idx,
      "/spec/surface",
    );
  }
  if ("cache" in s) validateViewCache(s["cache"], m, idx);
  if ("requires" in s && s["requires"] != null) {
    validateRequires(s["requires"], idx, "View");
  }
  const adminUiProblem = checkViewAdminUi(m).problems[0];
  if (adminUiProblem) {
    throw new ManifestParseError(adminUiProblem.message, idx, adminUiProblem.pointer, "VIEW_UI_INVALID");
  }
  if ("input" in s && s["input"] != null) {
    validateViewInput(s["input"], idx);
    validateJsonSchema(s["input"], idx, "View", m.metadata.name, "/spec/input");
  }
  return m;
}

function validateViewCache(raw: unknown, view: ViewManifest, idx: number): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError("View.spec.cache must be an object", idx, "/spec/cache", "VIEW_CACHE_INVALID");
  }
  const cache = raw as Record<string, unknown>;
  rejectUnknownKeys(cache, ["sharedMaxAge"], idx, "/spec/cache");
  const maxAge = cache["sharedMaxAge"];
  if (!Number.isInteger(maxAge) || (maxAge as number) < 1 || (maxAge as number) > 86_400) {
    throw new ManifestParseError(
      "View.spec.cache.sharedMaxAge must be an integer from 1 to 86400",
      idx,
      "/spec/cache/sharedMaxAge",
      "VIEW_CACHE_INVALID",
    );
  }
  // A shared cache must not hold a caller- or time-dependent answer. A match inside a
  // literal over-rejects, which is the safe direction.
  if (view.spec.surface !== "public" || view.spec.requires || /\bauth\s*\.|\bnow\s*\(/i.test(view.spec.sql)) {
    throw new ManifestParseError(
      "View.spec.cache requires an unguarded public View whose sql reads neither auth.* nor now()",
      idx,
      "/spec/cache",
      "VIEW_CACHE_INVALID",
    );
  }
}

function validateViewInput(raw: unknown, idx: number): void {
  const invalid = (message: string, pointer: string, code: DiagnosticCode = "VIEW_INPUT_INVALID_SHAPE"): never => {
    throw new ManifestParseError(message, idx, pointer, code);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("View.spec.input must be a JSON Schema object", "/spec/input");
  }
  const p = raw as Record<string, unknown>;
  if (p["type"] !== "object") {
    invalid(`View.spec.input.type must be "object"; got ${JSON.stringify(p["type"])}`, "/spec/input/type");
  }
  const props = p["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    invalid("View.spec.input.properties is required (declare each accepted parameter)", "/spec/input/properties");
  }
  for (const reserved of VIEW_INPUT_RESERVED) {
    if (Object.hasOwn(props as object, reserved)) {
      invalid(
        `View.spec.input.properties.${reserved} is reserved (the runtime owns ${VIEW_INPUT_RESERVED.join(", ")} for pagination); rename it.`,
        `/spec/input/properties/${reserved}`,
        "VIEW_INPUT_RESERVED_NAME",
      );
    }
  }
}

export function validateProcedureSpec(m: ProcedureManifest, idx: number): ProcedureManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(
    s,
    ["title", "description", "requires", "input", "uiSchema", "output", "handler", "mcp", "target"],
    idx,
    "/spec",
  );
  if (s["mcp"] !== undefined) {
    const mcp = s["mcp"];
    if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
      throw new ManifestParseError("Procedure.spec.mcp must be an object of boolean tool annotations", idx, "/spec/mcp");
    }
    rejectUnknownKeys(mcp as Record<string, unknown>, [...PROCEDURE_MCP_ANNOTATION_KEYS], idx, "/spec/mcp");
    for (const key of PROCEDURE_MCP_ANNOTATION_KEYS) {
      const value = (mcp as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== "boolean") {
        throw new ManifestParseError(`Procedure.spec.mcp.${key} must be a boolean`, idx, `/spec/mcp/${key}`);
      }
    }
    const hints = mcp as { readOnlyHint?: boolean; destructiveHint?: boolean };
    if (hints.readOnlyHint === true && hints.destructiveHint === true) {
      throw new ManifestParseError("Procedure.spec.mcp cannot be both readOnlyHint: true and destructiveHint: true", idx, "/spec/mcp");
    }
  }
  if (s["target"] !== undefined) validateProcedureTargetShape(s["target"], idx);
  validateLocalizedText(
    s["title"],
    idx,
    "/spec/title",
    "Procedure.spec.title",
    false,
  );
  validateLocalizedText(
    s["description"],
    idx,
    "/spec/description",
    "Procedure.spec.description",
    false,
  );
  if (typeof s["input"] !== "object" || s["input"] === null) {
    throw new ManifestParseError("Procedure.spec.input is required (JSON Schema)", idx, "/spec/input");
  }
  validateJsonSchema(s["input"], idx, "Procedure", m.metadata.name, "/spec/input");
  const uiProblem = checkFormUiSchema(s["input"] as JsonSchema, s["uiSchema"], "Procedure")[0];
  if (uiProblem) {
    throw new ManifestParseError(uiProblem.message, idx, uiProblem.pointer, "SCHEMA_UI_INVALID");
  }
  if (typeof s["output"] !== "object" || s["output"] === null) {
    throw new ManifestParseError("Procedure.spec.output is required (JSON Schema)", idx, "/spec/output");
  }
  validateJsonSchema(s["output"], idx, "Procedure", m.metadata.name, "/spec/output");
  const handler = s["handler"] as Record<string, unknown> | undefined;
  if (!handler) {
    throw new ManifestParseError("Procedure.spec.handler is required", idx, "/spec/handler");
  }
  validateHandlerBinding(handler, idx);
  if ("requires" in s && s["requires"] != null) {
    validateRequires(s["requires"], idx, "Procedure");
  }
  return m;
}

/** Shape only; graph validation checks the Schema and input properties. */
function validateProcedureTargetShape(target: unknown, idx: number): void {
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    throw new ManifestParseError(
      "Procedure.spec.target must be an object { schema, id, version? }",
      idx,
      "/spec/target",
      "PROCEDURE_TARGET_INVALID",
    );
  }
  rejectUnknownKeys(target as Record<string, unknown>, [...PROCEDURE_TARGET_KEYS], idx, "/spec/target");
  for (const key of PROCEDURE_TARGET_KEYS) {
    const value = (target as Record<string, unknown>)[key];
    if (value === undefined && key === "version") continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new ManifestParseError(
        `Procedure.spec.target.${key} must be a non-empty string`,
        idx,
        `/spec/target/${key}`,
        "PROCEDURE_TARGET_INVALID",
      );
    }
  }
}

function validateHandlerBinding(h: Record<string, unknown>, idx: number): void {
  const keys = Object.keys(h);
  const key = keys.length === 1 ? keys[0]! : undefined;
  if (key !== "ref" && key !== "sql") {
    throw new ManifestParseError(
      `Procedure.spec.handler must have exactly one key, \`ref\` or \`sql\`; got ${JSON.stringify(keys)}`,
      idx,
      "/spec/handler",
    );
  }
  // For `sql` only the SQL compiler (compilePlan) reads the statements; here it just has to be present.
  if (typeof h[key] !== "string" || (h[key] as string).trim().length === 0) {
    throw new ManifestParseError(
      key === "ref"
        ? "Procedure.spec.handler.ref is required (non-empty registration key)"
        : "Procedure.spec.handler.sql is required (one or more write statements)",
      idx,
      `/spec/handler/${key}`,
    );
  }
}

function validateRequires(req: unknown, idx: number, atom: "Procedure" | "View"): void {
  if (typeof req !== "object" || req === null) {
    throw new ManifestParseError(`${atom}.spec.requires must be an object`, idx);
  }
  const r = req as Record<string, unknown>;
  rejectUnknownKeys(r, ["auth", "guard"], idx, "/spec/requires");
  if ("guard" in r) {
    const guard = r["guard"];
    if (typeof guard !== "object" || guard === null || Array.isArray(guard)) {
      throw new ManifestParseError(`${atom}.spec.requires.guard must be an object`, idx);
    }
    const g = guard as Record<string, unknown>;
    if (typeof g["procedure"] !== "string" || g["procedure"].length === 0) {
      throw new ManifestParseError(
        `${atom}.spec.requires.guard.procedure must be a non-empty Procedure name`,
        idx,
      );
    }
    const extra = Object.keys(g).find((key) => key !== "procedure");
    if (extra !== undefined) {
      throw new ManifestParseError(
        `${atom}.spec.requires.guard.${extra} is not supported; guard accepts only \`procedure\``,
        idx,
      );
    }
  }
  if (!("auth" in r) || r["auth"] == null) return;
  const auth = r["auth"];
  if (typeof auth !== "object" || auth === null) {
    throw new ManifestParseError(`${atom}.spec.requires.auth must be an object`, idx);
  }
  const a = auth as Record<string, unknown>;
  rejectUnknownKeys(a, ["all"], idx, "/spec/requires/auth");
  if (!("all" in a)) {
    throw new ManifestParseError(
      `${atom}.spec.requires.auth must declare \`all\` (v0.1)`,
      idx,
    );
  }
  const all = a["all"];
  if (!Array.isArray(all) || all.length === 0) {
    throw new ManifestParseError(
      `${atom}.spec.requires.auth.all must be a non-empty array`,
      idx,
    );
  }
  for (let i = 0; i < all.length; i++) {
    validateAuthPredicate(
      all[i],
      idx,
      `${atom}.spec.requires.auth.all[${i}]`,
      `/spec/requires/auth/all/${i}`,
    );
  }
}

function validateAuthPredicate(
  p: unknown,
  idx: number,
  path: string,
  pointer: string,
): asserts p is AuthPredicate {
  if (p === "ctx.user" || p === "ctx.auth") return;
  if (typeof p === "object" && p !== null && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    if ("ctx.auth.scope" in o) {
      rejectUnknownKeys(o, ["ctx.auth.scope"], idx, pointer);
      const scope = o["ctx.auth.scope"];
      if (typeof scope !== "string" || scope.length === 0) {
        throw new ManifestParseError(
          `${path}: 'ctx.auth.scope' value must be a non-empty string`,
          idx,
        );
      }
      return;
    }
    if ("ctx.staff" in o) {
      rejectUnknownKeys(o, ["ctx.staff"], idx, pointer);
      const roles = o["ctx.staff"];
      if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => typeof r !== "string")) {
        throw new ManifestParseError(
          `${path}: 'ctx.staff' value must be a non-empty array of role-name strings`,
          idx,
        );
      }
      const badRole = (roles as readonly string[]).find((r) => !isStaffRole(r));
      if (badRole !== undefined) {
        throw new ManifestParseError(
          `${path}: 'ctx.staff' role '${badRole}' is not in STAFF_ROLES (${[...STAFF_ROLES].join(", ")})`,
          idx,
          undefined,
          "AUTH_PREDICATE_NOT_IN_ENUM",
        );
      }
      return;
    }
  }
  throw new ManifestParseError(
    `${path} must be 'ctx.user', 'ctx.auth', { 'ctx.auth.scope': <scope> }, or { 'ctx.staff': [<role>, ...] }; got ${JSON.stringify(p)}`,
    idx,
  );
}
