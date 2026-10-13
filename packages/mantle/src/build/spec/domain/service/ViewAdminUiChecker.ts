/** View.spec.uiSchema: the Admin list a View presents. */
import type { ViewManifest } from "../model/ManifestGrammar.js";
import { checkCells, type SchemaAdminUiProblem } from "./SchemaAdminUiChecker.js";

const problem = (pointer: string, value: unknown, expected: string, message: string): SchemaAdminUiProblem => ({ pointer, value, expected, message });

export interface ViewListPresentation {
  readonly columns: readonly string[];
  readonly searchFields: readonly string[];
  readonly filterFields: readonly string[];
}

const EMPTY_VIEW_LIST: ViewListPresentation = {
  columns: [],
  searchFields: [],
  filterFields: [],
};

/** Validate the deliberately small Admin list contract for staff Views. */
export function checkViewAdminUi(view: ViewManifest): {
  readonly list: ViewListPresentation;
  readonly problems: readonly SchemaAdminUiProblem[];
} {
  const uiSchema = view.spec.uiSchema;
  if (uiSchema === undefined) return { list: EMPTY_VIEW_LIST, problems: [] };
  if (view.spec.surface !== "staff") {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      "/spec/uiSchema",
      uiSchema,
      "Admin UI configuration on a surface: staff View",
      "View.spec.uiSchema is only supported for surface: staff Views.",
    )] };
  }
  if (!uiSchema || typeof uiSchema !== "object" || Array.isArray(uiSchema)) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      "/spec/uiSchema",
      uiSchema,
      "an object",
      "View.spec.uiSchema must be an object.",
    )] };
  }
  const unknownRoot = Object.keys(uiSchema).find((key) => key !== "list");
  if (unknownRoot) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      `/spec/uiSchema/${unknownRoot}`,
      uiSchema[unknownRoot],
      "list",
      `View.spec.uiSchema.${unknownRoot} is not supported.`,
    )] };
  }
  const list = uiSchema["list"];
  if (list === undefined) return { list: EMPTY_VIEW_LIST, problems: [] };
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      "/spec/uiSchema/list",
      list,
      "an object",
      "View.spec.uiSchema.list must be an object.",
    )] };
  }
  const config = list as Record<string, unknown>;
  const allowed = new Set(["columns", "searchFields", "filterFields", "cells"]);
  const unknown = Object.keys(config).find((key) => !allowed.has(key));
  if (unknown) {
    return { list: EMPTY_VIEW_LIST, problems: [problem(
      `/spec/uiSchema/list/${unknown}`,
      config[unknown],
      "columns, searchFields, filterFields, or cells",
      `View.spec.uiSchema.list.${unknown} is not supported.`,
    )] };
  }
  const normalized: Record<keyof ViewListPresentation, readonly string[]> = {
    columns: [],
    searchFields: [],
    filterFields: [],
  };
  for (const key of Object.keys(normalized) as Array<keyof ViewListPresentation>) {
    const raw = config[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || !raw.every((field) =>
      typeof field === "string" && field.length > 0 && !/["\\\0]/.test(field)
    )) {
      return { list: EMPTY_VIEW_LIST, problems: [problem(
        `/spec/uiSchema/list/${key}`,
        raw,
        "an array of non-empty View output field names",
        `View.spec.uiSchema.list.${key} must be an array of field-name strings.`,
      )] };
    }
    if (new Set(raw).size !== raw.length) {
      return { list: EMPTY_VIEW_LIST, problems: [problem(
        `/spec/uiSchema/list/${key}`,
        raw,
        "field names without duplicates",
        `View.spec.uiSchema.list.${key} must not repeat a field.`,
      )] };
    }
    normalized[key] = raw;
  }
  // the keys must be outputs, which only the compiled SELECT knows (compilePlan checks them)
  const cellProblem = checkCells(config["cells"], (field) => field.length > 0, "View", "a View output name");
  if (cellProblem) return { list: EMPTY_VIEW_LIST, problems: [cellProblem] };
  return { list: normalized, problems: [] };
}
