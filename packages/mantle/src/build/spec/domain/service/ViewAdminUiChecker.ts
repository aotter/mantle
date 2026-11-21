/** View.spec.uiSchema: the Admin list a View presents. */
import type { ViewManifest } from "../model/ManifestGrammar.js";
import { type SchemaAdminUiProblem } from "./SchemaAdminUiChecker.js";
import { navPlacementProblems } from "../model/AdminNav.js";

const problem = (pointer: string, value: unknown, expected: string, message: string): SchemaAdminUiProblem => ({
  pointer,
  value,
  expected,
  message,
});

/** Validate the deliberately small Admin list contract for admin Views. */
export function checkViewAdminUi(view: ViewManifest): SchemaAdminUiProblem | undefined {
  const uiSchema = view.spec.uiSchema;
  if (uiSchema === undefined) return undefined;
  if (view.spec.surface !== "admin") {
    return problem(
      "/spec/uiSchema",
      uiSchema,
      "Admin UI configuration on a surface: admin View",
      "View.spec.uiSchema is only supported for surface: admin Views.",
    );
  }
  if (!uiSchema || typeof uiSchema !== "object" || Array.isArray(uiSchema)) {
    return problem("/spec/uiSchema", uiSchema, "an object", "View.spec.uiSchema must be an object.");
  }
  const unknownRoot = Object.keys(uiSchema).find(key => key !== "list" && key !== "nav");
  if (unknownRoot) {
    return problem(
      `/spec/uiSchema/${unknownRoot}`,
      uiSchema[unknownRoot],
      "list or nav",
      `View.spec.uiSchema.${unknownRoot} is not supported.`,
    );
  }
  const nav = uiSchema["nav"];
  if (nav !== undefined) {
    if (!nav || typeof nav !== "object" || Array.isArray(nav))
      return problem("/spec/uiSchema/nav", nav, "an object", "View.spec.uiSchema.nav must be an object.");
    const bad = navPlacementProblems(nav as Record<string, unknown>);
    if (bad)
      return problem(
        `/spec/uiSchema/nav/${bad[0]}`,
        (nav as Record<string, unknown>)[bad[0]],
        bad[1],
        `View.spec.uiSchema.nav.${bad[0]} must be ${bad[1]}.`,
      );
  }
  const list = uiSchema["list"];
  if (list === undefined) return undefined;
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    return problem("/spec/uiSchema/list", list, "an object", "View.spec.uiSchema.list must be an object.");
  }
  const config = list as Record<string, unknown>;
  const allowed = new Set(["columns", "searchFields", "filterFields"]);
  const unknown = Object.keys(config).find(key => !allowed.has(key));
  if (unknown) {
    return problem(
      `/spec/uiSchema/list/${unknown}`,
      config[unknown],
      "columns, searchFields, or filterFields",
      `View.spec.uiSchema.list.${unknown} is not supported.`,
    );
  }
  for (const key of ["columns", "searchFields", "filterFields"]) {
    const raw = config[key];
    if (raw === undefined) continue;
    if (
      !Array.isArray(raw) ||
      !raw.every(field => typeof field === "string" && field.length > 0 && !/["\\\0]/.test(field))
    ) {
      return problem(
        `/spec/uiSchema/list/${key}`,
        raw,
        "an array of non-empty View output field names",
        `View.spec.uiSchema.list.${key} must be an array of field-name strings.`,
      );
    }
    if (new Set(raw).size !== raw.length) {
      return problem(
        `/spec/uiSchema/list/${key}`,
        raw,
        "field names without duplicates",
        `View.spec.uiSchema.list.${key} must not repeat a field.`,
      );
    }
  }
  return undefined;
}
