import {
  bootDiagnostic,
  checkLocaleAndTranslates,
  ValidateManifestsUseCase,
  type Diagnostic,
  type Manifest,
  type ProcedureManifest,
  type SchemaManifest,
  type TriggerManifest,
} from "@aotter/mantle-spec";
import { partitionManifests } from "@aotter/mantle-spec/partition";
import type { HandlerRegistry } from "../../domain/port/HandlerRegistry.js";
import {
  mcpToolNameSegment,
  RESERVED_MCP_GENERIC_TOOL_NAMES,
  RESERVED_MCP_TOOL_PREFIXES,
} from "../../domain/service/McpToolNaming.js";

/**
 * `ValidateBootUseCase` — Loop 3 of the SDK authoring contract (see
 * ADR-0007). Walks the parsed manifest set + in-memory handler
 * registry; refuses to proceed if any load-bearing invariant is violated. A
 * failure rejects `bootInit()` with `BootValidationError`; adapters must not
 * dispatch through an unbooted runtime. The conventional Cloudflare adapter
 * resets its rejected lazy-boot promise so transient infrastructure failures
 * can retry, while readiness/smoke requests surface deterministic authoring
 * failures before production traffic.
 *
 * v0.1.0 invariants:
 *   - Every `Procedure.handler.ref` is in the supplied registry.
 *   - Every `Procedure.handler.builtin.schema` resolves to a declared
 *     Schema (`BUILTIN_HANDLER_SCHEMA_UNKNOWN`). Builtin op execution
 *     itself ships in `InvokeBuiltinUseCase`.
 *   - Every `Trigger.target.procedure` resolves to a manifest.
 *   - Every `http` Trigger has a unique `(method, path)` pair and a
 *     `/api/` prefix outside Core-owned route namespaces.
 *   - Every `Trigger.source.kind: lifecycle` watches a declared Schema
 *     (`LIFECYCLE_SCHEMA_UNKNOWN`). The hook runtime is the
 *     `LifecycleHookingEntryRepository` decorator.
 *   - Schema index declarations resolve to supported scalar fields.
 *   - Locale + translates cross-Schema invariants (ADR-0010) hold.
 */
export type ValidateBootResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface ValidateBootRequest {
  readonly manifests: readonly Manifest[];
  readonly registry: HandlerRegistry;
  /** Adapter-owned route prefixes in addition to Core's fixed REST
   *  namespaces. The Cloudflare adapter supplies its configured Auth
   *  base path so HTTP Triggers cannot register ahead of Auth. */
  readonly reservedHttpPathPrefixes?: readonly string[];
  /** Site config locales (ADR-0010). Empty/absent enables the
   *  zero-locale-site path: any localized Schema fails boot with
   *  `SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES`. The runtime's
   *  bootInit reads this from `site_config` before validating. */
  readonly siteLocales?: readonly string[];
}

export class ValidateBootUseCase {
  execute(request: ValidateBootRequest): ValidateBootResponse {
    const partitioned = partitionManifests([...request.manifests]);
    const proceduresByName = new Map<string, ProcedureManifest>();
    for (const p of partitioned.procedures) proceduresByName.set(p.metadata.name, p);
    const schemasByName = new Map<string, SchemaManifest>();
    for (const s of partitioned.schemas) schemasByName.set(s.metadata.name, s);

    const diagnostics: Diagnostic[] = [];
    const procedureCandidates = [...proceduresByName.keys()];
    const schemaCandidates = [...schemasByName.keys()];
    const handlerCandidates = request.registry.list();

    for (const diagnostic of ValidateManifestsUseCase.run({
      manifests: request.manifests,
    }).diagnostics) {
      if (isBootBlockingManifestDiagnostic(diagnostic)) {
        diagnostics.push({ ...diagnostic, phase: "boot" });
      }
    }

    // 1. Procedure handler refs + builtin schema cross-resolution.
    for (const p of partitioned.procedures) {
      const h = p.spec.handler;
      if (h.kind === "ref" && !request.registry.has(h.ref)) {
        diagnostics.push(
          bootDiagnostic({
            code: "HANDLER_NOT_REGISTERED",
            severity: "error",
            path: `manifest:Procedure/${p.metadata.name}#/spec/handler/ref`,
            value: h.ref,
            expected: `a function passed through the handlers option under key '${h.ref}'`,
            candidates: handlerCandidates,
            message: `Procedure '${p.metadata.name}' declares handler.ref '${h.ref}' but no handler is registered for that key. Wire it in your project's handlers map: { '${h.ref}': ... }.`,
          }),
        );
      }
      if (h.kind === "builtin" && !schemasByName.has(h.schema)) {
        diagnostics.push(
          bootDiagnostic({
            code: "BUILTIN_HANDLER_SCHEMA_UNKNOWN",
            severity: "error",
            path: `manifest:Procedure/${p.metadata.name}#/spec/handler/schema`,
            value: h.schema,
            expected: "name of a declared Schema",
            candidates: schemaCandidates,
            message: `Procedure '${p.metadata.name}' (handler.kind: builtin) targets unknown Schema '${h.schema}'.`,
          }),
        );
      }
    }

    // Guard Procedures are ordinary ref handlers, but the guard graph
    // is intentionally one level deep. Validate it again at boot so
    // programmatically-built manifests cannot bypass the spec CLI.
    for (const target of [...partitioned.procedures, ...partitioned.views]) {
      const guardName = target.spec.requires?.guard?.procedure;
      if (!guardName) continue;
      const path = `manifest:${target.kind}/${target.metadata.name}#/spec/requires/guard/procedure`;
      const guard = proceduresByName.get(guardName);
      if (!guard) {
        diagnostics.push(
          bootDiagnostic({
            code: "GUARD_PROCEDURE_UNKNOWN",
            severity: "error",
            path,
            value: guardName,
            expected: "name of a declared Procedure",
            candidates: procedureCandidates,
            message: `${target.kind} '${target.metadata.name}' references unknown guard Procedure '${guardName}'.`,
          }),
        );
        continue;
      }
      if (target.kind === "Procedure" && target.metadata.name === guardName) {
        diagnostics.push(
          bootDiagnostic({
            code: "GUARD_SELF_REFERENCE",
            severity: "error",
            path,
            value: guardName,
            expected: "a different, unguarded Procedure",
            message: `Procedure '${target.metadata.name}' cannot guard itself.`,
          }),
        );
        continue;
      }
      if (guard.spec.handler.kind !== "ref") {
        diagnostics.push(
          bootDiagnostic({
            code: "GUARD_PROCEDURE_BUILTIN",
            severity: "error",
            path,
            value: guardName,
            expected: "a Procedure with handler.kind: ref",
            message: `${target.kind} '${target.metadata.name}' uses '${guardName}' as a guard, but guard Procedures cannot use builtin handlers.`,
          }),
        );
      }
      if (guard.spec.requires?.guard) {
        diagnostics.push(
          bootDiagnostic({
            code: "GUARD_CHAIN_NOT_ALLOWED",
            severity: "error",
            path,
            value: guardName,
            expected: "an unguarded Procedure",
            message: `${target.kind} '${target.metadata.name}' uses '${guardName}' as a guard, but guard chains are not allowed.`,
          }),
        );
      }
    }

    // 2. Trigger.target.procedure resolves.
    for (const t of partitioned.triggers) {
      if (!proceduresByName.has(t.spec.target.procedure)) {
        diagnostics.push(
          bootDiagnostic({
            code: "TRIGGER_TARGET_PROCEDURE_UNKNOWN",
            severity: "error",
            path: `manifest:Trigger/${t.metadata.name}#/spec/target/procedure`,
            value: t.spec.target.procedure,
            expected: "name of a declared Procedure",
            candidates: procedureCandidates,
            message: `Trigger '${t.metadata.name}' targets unknown Procedure '${t.spec.target.procedure}'.`,
          }),
        );
      }
      if (t.spec.source.kind === "lifecycle") {
        if (!schemasByName.has(t.spec.source.schema)) {
          diagnostics.push(
            bootDiagnostic({
              code: "LIFECYCLE_SCHEMA_UNKNOWN",
              severity: "error",
              path: `manifest:Trigger/${t.metadata.name}#/spec/source/schema`,
              value: t.spec.source.schema,
              expected: "name of a declared Schema",
              candidates: schemaCandidates,
              message: `Trigger '${t.metadata.name}' watches unknown Schema '${t.spec.source.schema}'.`,
            }),
          );
        }
      }
    }

    // 3. HTTP trigger uniqueness + Core route ownership.
    diagnostics.push(...checkHttpRouteCollisions(partitioned.triggers));
    diagnostics.push(
      ...checkHttpRoutePrefix(
        partitioned.triggers,
        request.reservedHttpPathPrefixes,
      ),
    );

    // 4. MCP tool-name collision (POC PR #48): per-collection tool
    //    emission lowercases + kebab→snake the Schema name; two
    //    Schemas that mangle to the same suffix would silently
    //    overwrite each other in `tools/list`.
    diagnostics.push(
      ...checkMcpToolNameCollisions(partitioned.schemas, partitioned.procedures),
    );

    // 5. Locale + translates cross-Schema invariants.
    diagnostics.push(
      ...checkLocaleAndTranslates({
        schemas: partitioned.schemas,
        phase: "boot",
        siteLocales: request.siteLocales,
      }),
    );

    if (diagnostics.length === 0) return { ok: true };
    return { ok: false, diagnostics };
  }

  /** Validate; on failure, throw `BootValidationError`. */
  assert(request: ValidateBootRequest): void {
    const result = this.execute(request);
    if (!result.ok) throw new BootValidationError(result.diagnostics);
  }
}

function isBootBlockingManifestDiagnostic(diagnostic: Diagnostic): boolean {
  return diagnostic.code === "SCHEMA_INDEX_INVALID" ||
    diagnostic.code === "SCHEMA_INDEX_FIELD_UNKNOWN" ||
    diagnostic.code === "UNIQUE_INDEX_FIELD_UNKNOWN" ||
    diagnostic.code === "SCHEMA_SEARCH_INVALID" ||
    diagnostic.code === "SCHEMA_SEARCH_FIELD_UNKNOWN" ||
    diagnostic.code === "SCHEMA_UI_INVALID" ||
    diagnostic.code === "VIEW_FILTER_CTX_USER_REF_INVALID" ||
    diagnostic.code === "VIEW_FILTER_CTX_USER_REF_REQUIRES_AUTH" ||
    diagnostic.code === "VIEW_FILTER_CTX_USER_REF_REQUIRES_INDEX";
}

function checkHttpRouteCollisions(triggers: readonly TriggerManifest[]): Diagnostic[] {
  const seen = new Map<string, string>();
  const out: Diagnostic[] = [];
  for (const t of triggers) {
    if (t.spec.source.kind !== "http") continue;
    const key = `${t.spec.source.method} ${t.spec.source.path}`;
    const prior = seen.get(key);
    if (prior) {
      out.push(
        bootDiagnostic({
          code: "TRIGGER_PATH_COLLISION",
          severity: "error",
          path: `manifest:Trigger/${t.metadata.name}#/spec/source`,
          value: key,
          expected: `unique (method, path) across http Triggers (also declared by '${prior}')`,
          message: `Trigger '${t.metadata.name}' shares route ${key} with Trigger '${prior}'.`,
        }),
      );
    } else {
      seen.set(key, t.metadata.name);
    }
  }
  return out;
}

const CORE_RESERVED_HTTP_PATH_PREFIXES = ["/api/auth", "/api/views"] as const;

function checkHttpRoutePrefix(
  triggers: readonly TriggerManifest[],
  adapterReservedPrefixes: readonly string[] = [],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const reservedPrefixes = [
    ...new Set([...CORE_RESERVED_HTTP_PATH_PREFIXES, ...adapterReservedPrefixes]),
  ];
  for (const t of triggers) {
    if (t.spec.source.kind !== "http") continue;
    const path = t.spec.source.path;
    const reservedPrefix = reservedPrefixes.find((prefix) =>
      prefix.length > 0 && hasPathPrefix(path, prefix)
    );
    if (!path.startsWith("/api/") || reservedPrefix) {
      out.push(
        bootDiagnostic({
          code: "TRIGGER_PATH_INVALID",
          severity: "error",
          path: `manifest:Trigger/${t.metadata.name}#/spec/source/path`,
          value: path,
          expected: reservedPrefix
            ? `path outside Core-owned prefix '${reservedPrefix}'`
            : "path starting with '/api/'",
          message: reservedPrefix
            ? `Trigger '${t.metadata.name}' has path '${path}', which is owned by Core under '${reservedPrefix}'.`
            : `Trigger '${t.metadata.name}' has path '${path}' — http Trigger ` +
              `paths MUST start with '/api/' so adapters can route public ` +
              `pages and Procedure endpoints without ambiguity.`,
        }),
      );
    }
  }
  return out;
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix ||
    path.startsWith(`${prefix}/`) ||
    path.startsWith(`${prefix}{`);
}

interface ToolNameOwner {
  readonly kind: "Schema" | "Procedure";
  readonly name: string;
}

function checkMcpToolNameCollisions(
  schemas: readonly SchemaManifest[],
  procedures: readonly ProcedureManifest[],
): Diagnostic[] {
  const seen = new Map<string, ToolNameOwner>();
  const out: Diagnostic[] = [];
  for (const s of schemas) {
    const segment = mcpToolNameSegment(s.metadata.name);
    const prior = seen.get(segment);
    if (prior && !sameOwner(prior, "Schema", s.metadata.name)) {
      out.push(
        bootDiagnostic({
          code: "MCP_TOOL_NAME_COLLISION",
          severity: "error",
          path: `manifest:Schema/${s.metadata.name}#/metadata/name`,
          value: segment,
          expected: `Schema name unique after kebab→snake mangling (collides with '${prior.name}')`,
          message:
            `Schema '${s.metadata.name}' mangles to MCP tool suffix '${segment}', ` +
            `which already comes from Schema '${prior.name}'. Rename one of the Schemas ` +
            `(e.g. avoid mixing '${prior.name}' and '${s.metadata.name}') so per-collection ` +
            `MCP tool emission stays unambiguous.`,
        }),
      );
    } else if (!prior) {
      seen.set(segment, { kind: "Schema", name: s.metadata.name });
    }
  }
  // Procedure tool names (#281) share the catalog namespace. Reject
  // anything that collides with a generic tool, a reserved
  // content/record authoring or query_view_ prefix, a schema-mangled
  // segment, or another procedure. We don't gate by whether the
  // Procedure has an `mcp` Trigger today — names must stay portable
  // so an adopter can add the Trigger later without renaming.
  for (const p of procedures) {
    const name = mcpToolNameSegment(p.metadata.name);
    let conflict: string | null = null;
    if (RESERVED_MCP_GENERIC_TOOL_NAMES.has(name)) {
      conflict = `built-in MCP tool '${name}'`;
    } else if (RESERVED_MCP_TOOL_PREFIXES.some((pfx) => name.startsWith(pfx))) {
      const prefix = RESERVED_MCP_TOOL_PREFIXES.find((pfx) => name.startsWith(pfx));
      conflict = `reserved tool-name prefix '${prefix}' (used by Schema / View tools)`;
    } else {
      const prior = seen.get(name);
      if (prior && !sameOwner(prior, "Procedure", p.metadata.name)) {
        conflict = `${prior.kind} '${prior.name}'`;
      }
    }
    if (conflict) {
      out.push(
        bootDiagnostic({
          code: "MCP_TOOL_NAME_COLLISION",
          severity: "error",
          path: `manifest:Procedure/${p.metadata.name}#/metadata/name`,
          value: name,
          expected: `Procedure name unique after kebab→snake mangling (collides with ${conflict})`,
          message:
            `Procedure '${p.metadata.name}' mangles to MCP tool name '${name}', ` +
            `which collides with ${conflict}. Rename the Procedure so its MCP tool ` +
            `name does not shadow the existing tool surface.`,
        }),
      );
      continue;
    }
    seen.set(name, { kind: "Procedure", name: p.metadata.name });
  }
  return out;
}

function sameOwner(
  prior: ToolNameOwner,
  candidateKind: "Schema" | "Procedure",
  candidateName: string,
): boolean {
  return prior.kind === candidateKind && prior.name === candidateName;
}

/**
 * Single Error wrapping every boot diagnostic. The runtime throws this
 * during `bootInit`; adapters surface it in their init logs.
 */
export class BootValidationError extends Error {
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    const summary = diagnostics
      .map((d) => `  - ${d.code} (phase: ${d.phase}) at ${d.path}: ${d.message}`)
      .join("\n");
    super(
      `Runtime boot validation failed (${diagnostics.length} error(s)):\n${summary}\n\n` +
        `See ADR-0007 (boot-time fail-fast) for context. Diagnostics also ` +
        `available on the .diagnostics field of this error for programmatic handling.`,
    );
    this.name = "BootValidationError";
  }
}
