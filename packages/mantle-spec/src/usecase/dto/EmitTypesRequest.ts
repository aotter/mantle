import type { Manifest } from "../../domain/model/ManifestGrammar.js";
import type { LinkedManifestSet } from "../../domain/service/ManifestLinker.js";

export type EmitTypesRequest = {
  readonly namespace: string;
} & (
  | { readonly manifests: ReadonlyArray<Manifest>; readonly linked?: never }
  | { readonly linked: LinkedManifestSet; readonly manifests?: never }
);
