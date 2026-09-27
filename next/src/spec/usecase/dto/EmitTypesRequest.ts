import type { LinkedManifestSet } from "../../domain/service/ManifestLinker.js";

export interface EmitTypesRequest {
  readonly namespace: string;
  readonly linked: LinkedManifestSet;
}
