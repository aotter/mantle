import { fetchService } from "./service.js";
import { scheduled } from "./schedule.js";

// Local `wrangler dev` (workerd) drops the connection when a request ends with its body unread, which fails the next
// request ("Network connection lost"). Rejections answer before reading the body, so drain what is left.
const fetch: ExportedHandlerFetchHandler<Env> = async (request, env, context) => {
  const response = await fetchService(request, env, context);
  if (request.body && !request.bodyUsed) await request.arrayBuffer().catch(() => undefined);
  return response;
};

export default { fetch, scheduled } satisfies ExportedHandler<Env>;
