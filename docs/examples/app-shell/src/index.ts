import { fetchService } from "./service.js";
import { scheduled } from "./schedule.js";

export default { fetch: fetchService, scheduled } satisfies ExportedHandler<Env>;
