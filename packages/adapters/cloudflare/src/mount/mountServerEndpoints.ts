import type { Env, Hono } from "hono";
import type { CmsRuntimeRef } from "./bootRuntimeOnce.js";
import { mountAdmin } from "./mountAdmin.js";
import { mountRuntimeEndpoints } from "./mountRuntimeEndpoints.js";

/** @deprecated Compose `mountRuntimeEndpoints` and optional `mountAdmin` explicitly. */
export function mountServerEndpoints<E extends Env>(
  app: Hono<E>,
  ref: CmsRuntimeRef,
): void {
  mountRuntimeEndpoints(app, ref);
  if (ref.adminAssets) mountAdmin(app, ref, ref.adminAssets);
}

export type { CmsRuntimeRef };
