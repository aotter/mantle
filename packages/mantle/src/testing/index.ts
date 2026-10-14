import { userCaller } from "../kernel/user-fields.js";

/** Build an original, branded user Caller for direct tests of generated operations. */
export function authenticatedAs(user: Parameters<typeof userCaller>[0], options?: Parameters<typeof userCaller>[1]): ReturnType<typeof userCaller> {
  return userCaller(user, options);
}
