import { partitionManifests } from "../domain/service/ManifestParser.js";
import type {
  IntrospectManifestsRequest,
} from "./dto/IntrospectManifestsRequest.js";
import type {
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
        indexes: s.spec.indexes ?? [],
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
      auth: v.spec.requires?.auth ?? null,
      guard: v.spec.requires?.guard ?? null,
    }));
    const procedures: IntrospectedProcedure[] = partitioned.procedures.map((p) => ({
      name: p.metadata.name,
      handler: p.spec.handler,
      auth: p.spec.requires?.auth ?? null,
      guard: p.spec.requires?.guard ?? null,
      input: p.spec.input,
      output: p.spec.output,
    }));
    const triggers: IntrospectedTrigger[] = partitioned.triggers.map((t) => ({
      name: t.metadata.name,
      source: t.spec.source,
      target: t.spec.target,
    }));
    return { schemas, views, procedures, triggers, parseErrors: request.parseErrors };
  }

  static run(request: IntrospectManifestsRequest): IntrospectManifestsResponse {
    return new IntrospectManifestsUseCase().execute(request);
  }
}
