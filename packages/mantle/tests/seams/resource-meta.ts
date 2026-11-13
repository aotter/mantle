/** Required application seam `app-resource-meta` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { mcp } from "@aotter/mantle/mcp";
import type { Caller } from "@aotter/mantle/contracts";
import { tools } from "./generated/mcp.js";
import type { store } from "./generated/generated.js";

export const serve = (db: Parameters<typeof store>[0], caller: Caller) =>
  mcp(tools, {
    db: () => db,
    caller: () => caller,
    apps: {
      public: {
        resources: [
          {
            uri: "ui://seam/app",
            name: "seam-app",
            renders: ["add_note"],
            html: "<!doctype html>",
            meta: { "example/resource": { c: 3 } },
          },
        ],
      },
    },
  });
