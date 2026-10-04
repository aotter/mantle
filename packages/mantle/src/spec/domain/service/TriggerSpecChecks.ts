/** Trigger.spec and its sources: http, lifecycle, mcp and schedule. */
import type { HttpMethod, LifecycleHook, TriggerManifest } from "../model/ManifestGrammar.js";
import { ManifestParseError, V01_HTTP_METHODS, V01_LIFECYCLE_HOOKS, V01_MCP_TRIGGER_SURFACES, V01_TRIGGER_SOURCE_KINDS, rejectUnknownKeys } from "./ManifestFieldChecks.js";

function validateHttpSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(source, ["kind", "method", "path"], idx, "/spec/source");
  const method = source["method"];
  if (typeof method !== "string" || !V01_HTTP_METHODS.has(method as HttpMethod)) {
    throw new ManifestParseError(
      `Trigger.spec.source.method must be one of ${[...V01_HTTP_METHODS].join(", ")} (v0.1); got ${JSON.stringify(method)}`,
      idx,
      "/spec/source/method",
    );
  }
  const path = source["path"];
  if (typeof path !== "string" || path.length === 0 || !path.startsWith("/")) {
    throw new ManifestParseError(
      "Trigger.spec.source.path is required (non-empty string starting with '/')",
      idx,
      "/spec/source/path",
    );
  }
}

function validateLifecycleSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(
    source,
    ["kind", "schema", "on"],
    idx,
    "/spec/source",
  );
  if (typeof source["schema"] !== "string" || (source["schema"] as string).length === 0) {
    throw new ManifestParseError(
      "Trigger.spec.source.schema is required (Schema metadata.name) when source.kind is 'lifecycle'",
      idx,
      "/spec/source/schema",
    );
  }
  const on = source["on"];
  if (!Array.isArray(on) || on.length === 0) {
    throw new ManifestParseError(
      `Trigger.spec.source.on must be a non-empty array of hook names (one of ${[...V01_LIFECYCLE_HOOKS].join(", ")})`,
      idx,
      "/spec/source/on",
    );
  }
  for (let i = 0; i < on.length; i++) {
    const hook = on[i];
    if (typeof hook !== "string" || !V01_LIFECYCLE_HOOKS.has(hook as LifecycleHook)) {
      throw new ManifestParseError(
        `Trigger.spec.source.on[${i}] must be one of ${[...V01_LIFECYCLE_HOOKS].join(", ")}; got ${JSON.stringify(hook)}`,
        idx,
        `/spec/source/on/${i}`,
      );
    }
  }
}

function validateMcpSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(source, ["kind", "surface"], idx, "/spec/source");
  const surface = source["surface"];
  if (typeof surface !== "string" || !V01_MCP_TRIGGER_SURFACES.has(surface)) {
    throw new ManifestParseError(
      `Trigger.spec.source.surface must be one of ${[...V01_MCP_TRIGGER_SURFACES].join(", ")}; got ${JSON.stringify(surface)}`,
      idx,
      "/spec/source/surface",
    );
  }
}

function validateScheduleSource(source: Record<string, unknown>, idx: number): void {
  rejectUnknownKeys(source, ["kind", "cron", "enabled"], idx, "/spec/source");
  const cron = source["cron"];
  // Five-field POSIX cron in UTC: weekday 0 = Sunday through 6.
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  const fields = typeof cron === "string" ? cron.split(" ") : [];
  const valid = fields.length === 5 && fields.every((field, index) => {
    const [min, max] = bounds[index]!;
    return field.split(",").every((part) => {
      const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
      if (!match) return false;
      const start: number = match[1] === "*" ? min : Number(match[1]);
      const end: number = match[2] === undefined ? (match[1] === "*" ? max : start) : Number(match[2]);
      const step = match[3] === undefined ? 1 : Number(match[3]);
      return start >= min && end <= max && start <= end && step >= 1 && (match[3] === undefined || match[1] === "*" || match[2] !== undefined);
    });
  });
  if (!valid) throw new ManifestParseError(
    "Trigger.spec.source.cron must be a five-field POSIX UTC cron expression (minute hour day month weekday, 0=Sunday)",
    idx, "/spec/source/cron",
  );
  if (source["enabled"] !== undefined && typeof source["enabled"] !== "boolean") {
    throw new ManifestParseError("Trigger.spec.source.enabled must be boolean", idx, "/spec/source/enabled");
  }
}

export function validateTriggerSpec(m: TriggerManifest, idx: number): TriggerManifest {
  const s = m.spec as unknown as Record<string, unknown>;
  rejectUnknownKeys(s, ["source", "target"], idx, "/spec");
  const source = s["source"] as Record<string, unknown> | undefined;
  if (!source) {
    throw new ManifestParseError("Trigger.spec.source is required", idx, "/spec/source");
  }
  const sourceKind = source["kind"];
  if (typeof sourceKind !== "string") {
    throw new ManifestParseError(
      `Trigger.spec.source.kind is required (one of ${[...V01_TRIGGER_SOURCE_KINDS].join(", ")})`,
      idx,
      "/spec/source/kind",
    );
  }
  if (!V01_TRIGGER_SOURCE_KINDS.has(sourceKind)) {
    throw new ManifestParseError(
      `Trigger.spec.source.kind must be one of ${[...V01_TRIGGER_SOURCE_KINDS].join(", ")}; got '${sourceKind}'`,
      idx,
      "/spec/source/kind",
    );
  }
  if (sourceKind === "http") validateHttpSource(source, idx);
  else if (sourceKind === "lifecycle") validateLifecycleSource(source, idx);
  else if (sourceKind === "mcp") validateMcpSource(source, idx);
  else if (sourceKind === "schedule") validateScheduleSource(source, idx);
  const target = s["target"] as Record<string, unknown> | undefined;
  if (!target || typeof target["procedure"] !== "string") {
    throw new ManifestParseError("Trigger.spec.target.procedure is required (string)", idx, "/spec/target/procedure");
  }
  rejectUnknownKeys(target, ["procedure"], idx, "/spec/target");
  return m;
}
