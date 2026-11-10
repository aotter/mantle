/** Trigger.spec and its sources: http and mcp. */
import type { HttpMethod, TriggerManifest } from "../model/ManifestGrammar.js";
import { ManifestParseError, V01_HTTP_METHODS, V01_MCP_TRIGGER_SURFACES, V01_TRIGGER_SOURCE_KINDS, rejectUnknownKeys } from "./ManifestFieldChecks.js";

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

/** Former source kinds, each refused with what to write instead. */
const REMOVED_SOURCE_KINDS: Readonly<Record<string, string>> = {
  schedule: "Schedule Triggers are unsupported. Wire scheduled() yourself.",
  lifecycle: "Before/after lifecycle hooks are unsupported. Write a custom handler.",
};

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
  if (Object.hasOwn(REMOVED_SOURCE_KINDS, sourceKind)) {
    throw new ManifestParseError(
      `Trigger.spec.source.kind '${sourceKind}' is not accepted (one of ${[...V01_TRIGGER_SOURCE_KINDS].join(", ")}). ${REMOVED_SOURCE_KINDS[sourceKind]}`,
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
  else validateMcpSource(source, idx);
  const target = s["target"] as Record<string, unknown> | undefined;
  if (!target || typeof target["procedure"] !== "string") {
    throw new ManifestParseError("Trigger.spec.target.procedure is required (string)", idx, "/spec/target/procedure");
  }
  rejectUnknownKeys(target, ["procedure"], idx, "/spec/target");
  return m;
}
