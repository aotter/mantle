import { partitionManifests } from "../domain/service/ManifestParser.js";
import type {
  AdminActionAudience,
  AdminActionManualRunMode,
  AdminActionMetadata,
  AdminActionOperationKind,
  ProcedureManifest,
  TriggerManifest,
} from "../domain/model/ManifestGrammar.js";
import type {
  IntrospectManifestsRequest,
} from "./dto/IntrospectManifestsRequest.js";
import type {
  IntrospectedAdminAction,
  IntrospectedAdminActionTrigger,
  IntrospectManifestsResponse,
  IntrospectedProcedure,
  IntrospectedSchema,
  IntrospectedTrigger,
  IntrospectedView,
} from "./dto/IntrospectManifestsResponse.js";

/**
 * Walk a parsed manifest set and project the derived shape per atom.
 * Pure: no I/O, no FS. The CLI is the only adapter today; future
 * surfaces (admin UI, MCP introspection tool) call this same use case.
 */
export class IntrospectManifestsUseCase {
  execute(request: IntrospectManifestsRequest): IntrospectManifestsResponse {
    const partitioned = partitionManifests(request.manifests);
    const schemas: IntrospectedSchema[] = partitioned.schemas.map((s) => {
      const properties = (s.spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
      return {
        name: s.metadata.name,
        title: s.spec.title,
        localized: s.spec.localized ?? false,
        lifecycle: s.spec.lifecycle ?? "simple",
        translates: s.spec.translates ?? null,
        uniqueIndexes: s.spec.uniqueIndexes ?? [],
        properties: Object.keys(properties),
      };
    });
    const views: IntrospectedView[] = partitioned.views.map((v) => ({
      name: v.metadata.name,
      from: v.spec.from,
      params: v.spec.params ?? null,
      filter: v.spec.filter ?? null,
      orderBy: v.spec.orderBy ?? [],
      fields: v.spec.fields ?? null,
      limit: v.spec.limit ?? null,
      restPath: `/api/views/${v.metadata.name}`,
    }));
    const procedures: IntrospectedProcedure[] = partitioned.procedures.map((p) => ({
      name: p.metadata.name,
      handler: p.spec.handler,
      auth: p.spec.requires?.auth ?? null,
      input: p.spec.input,
      output: p.spec.output,
    }));
    const triggers: IntrospectedTrigger[] = partitioned.triggers.map((t) => ({
      name: t.metadata.name,
      source: t.spec.source,
      target: t.spec.target,
    }));
    const adminActions = buildAdminActionItems(partitioned.procedures, partitioned.triggers);
    return { schemas, views, procedures, triggers, adminActions, parseErrors: request.parseErrors };
  }

  static run(request: IntrospectManifestsRequest): IntrospectManifestsResponse {
    return new IntrospectManifestsUseCase().execute(request);
  }
}

function buildAdminActionItems(
  procedures: readonly ProcedureManifest[],
  triggers: readonly TriggerManifest[],
): readonly IntrospectedAdminAction[] {
  const triggersByProcedure = new Map<string, TriggerManifest[]>();
  for (const trigger of triggers) {
    const list = triggersByProcedure.get(trigger.spec.target.procedure) ?? [];
    list.push(trigger);
    triggersByProcedure.set(trigger.spec.target.procedure, list);
  }

  return procedures.map((procedure) => {
    const actionTriggers = triggersByProcedure.get(procedure.metadata.name) ?? [];
    const declared = readAdminActionMetadata(procedure.spec.admin);
    const triggerMetadata = firstDeclaredTriggerMetadata(actionTriggers);
    const operationKind = declared.operationKind ?? triggerMetadata.operationKind ?? "generic";
    const audience = declared.audience ?? triggerMetadata.audience ?? "staff";
    const manualRun = declared.manualRun ?? triggerMetadata.manualRun ?? "recommended";
    return {
      name: procedure.metadata.name,
      input: procedure.spec.input,
      output: procedure.spec.output,
      requiresAuth: Boolean(procedure.spec.requires?.auth),
      handlerKind: procedure.spec.handler.kind,
      handlerRef: procedure.spec.handler.kind === "ref" ? procedure.spec.handler.ref : undefined,
      description: declared.description ?? stringDescription(procedure.spec.input),
      outputDescription: declared.outputDescription ?? stringDescription(procedure.spec.output),
      operationKind,
      audience,
      manualRun,
      triggers: actionTriggers.map(triggerSummary),
    };
  });
}

function firstDeclaredTriggerMetadata(triggers: readonly TriggerManifest[]): Partial<AdminActionMetadata> {
  for (const trigger of triggers) {
    const metadata = readAdminActionMetadata(trigger.spec.admin);
    if (metadata.operationKind || metadata.audience || metadata.manualRun) return metadata;
  }
  return {};
}

function triggerSummary(trigger: TriggerManifest): IntrospectedAdminActionTrigger {
  const source = trigger.spec.source;
  if (source.kind === "http") {
    return {
      name: trigger.metadata.name,
      sourceKind: source.kind,
      method: source.method,
      path: source.path,
    };
  }
  if (source.kind === "lifecycle") {
    return {
      name: trigger.metadata.name,
      sourceKind: source.kind,
      schema: source.schema,
      hooks: source.on,
    };
  }
  return {
    name: trigger.metadata.name,
    sourceKind: source.kind,
    surface: source.surface,
  };
}

function readAdminActionMetadata(value: unknown): Partial<AdminActionMetadata> {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    description: typeof record.description === "string" ? record.description : undefined,
    outputDescription: typeof record.outputDescription === "string" ? record.outputDescription : undefined,
    operationKind: isOperationKind(record.operationKind) ? record.operationKind : undefined,
    audience: isAudience(record.audience) ? record.audience : undefined,
    manualRun: isManualRun(record.manualRun) ? record.manualRun : undefined,
  };
}

function stringDescription(schema: { readonly description?: unknown }): string | undefined {
  return typeof schema.description === "string" ? schema.description : undefined;
}

function isOperationKind(value: unknown): value is AdminActionOperationKind {
  return value === "checkout" || value === "inventory" || value === "orders" || value === "system" || value === "generic";
}

function isAudience(value: unknown): value is AdminActionAudience {
  return value === "staff" || value === "storefront" || value === "system" || value === "agent";
}

function isManualRun(value: unknown): value is AdminActionManualRunMode {
  return value === "recommended" || value === "debug" || value === "advanced";
}
