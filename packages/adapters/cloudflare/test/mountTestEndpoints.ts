import type { Env, Hono } from "hono";
import type { MantleRuntimeRef } from "../src/mount/bootRuntimeOnce.js";
import { mountAdmin } from "../src/mount/mountAdmin.js";
import { mountRuntimeEndpoints } from "../src/mount/mountRuntimeEndpoints.js";

export function mountTestEndpoints<E extends Env>(
  app: Hono<E>,
  ref: MantleRuntimeRef,
): void {
  mountRuntimeEndpoints(app, ref);
  if (ref.adminAssets) mountAdmin(app, ref, ref.adminAssets);
}
