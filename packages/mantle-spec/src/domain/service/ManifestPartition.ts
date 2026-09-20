import type {
  Manifest,
  ProcedureManifest,
  SchemaManifest,
  TriggerManifest,
  ViewManifest,
} from "../model/ManifestGrammar.js";

/** Bucketize already parsed/generated manifests without importing the YAML parser. */
export function partitionManifests(manifests: readonly Manifest[]): {
  schemas: SchemaManifest[];
  views: ViewManifest[];
  procedures: ProcedureManifest[];
  triggers: TriggerManifest[];
} {
  const schemas: SchemaManifest[] = [];
  const views: ViewManifest[] = [];
  const procedures: ProcedureManifest[] = [];
  const triggers: TriggerManifest[] = [];
  for (const manifest of manifests) {
    if (manifest.kind === "Schema") schemas.push(manifest);
    else if (manifest.kind === "View") views.push(manifest);
    else if (manifest.kind === "Procedure") procedures.push(manifest);
    else triggers.push(manifest);
  }
  return { schemas, views, procedures, triggers };
}
