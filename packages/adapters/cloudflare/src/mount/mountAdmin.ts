import type { Env, Hono } from "hono";
import {
  mountMantleAdmin,
  type AdminAssetServer,
} from "@aotter/mantle-admin";
import type { MantleRuntimeRef } from "./bootRuntimeOnce.js";
import { readWaitUntil } from "./mountRuntimeEndpoints.js";

/** Bind Cloudflare request context to the portable Admin mount. */
export function mountAdmin<E extends Env>(
  app: Hono<E>,
  ref: MantleRuntimeRef,
  assets: AdminAssetServer,
): void {
  mountMantleAdmin(app, {
    get: () => ref.get(),
    plan: ref.plan,
    auth: ref.auth,
    assets,
    requestContext: (context) => ({
      env: context.env ?? {},
      waitUntil: readWaitUntil(context),
    }),
  });
}
