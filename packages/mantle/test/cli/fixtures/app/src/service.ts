import { createMantle, type MantleService } from "@aotter/mantle";
import { sqliteStorage } from "@aotter/mantle/d1";
import { plan } from "../.mantle/generated/mantle.js";
import { handlers } from "./handlers.js";

const service: MantleService = { handlers, fetch: () => new Response("ok") };
export const mantle = createMantle(service, { plan, storage: () => sqliteStorage({ batch: async () => [] }) });
