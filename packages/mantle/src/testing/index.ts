import { userCaller } from "../kernel/user-fields.js";
import { hostCaller, type HostProps } from "../kernel/host-caller.js";

/** Build an original, branded user Caller for direct tests of generated operations. */
export function authenticatedAs(user: Parameters<typeof userCaller>[0], options?: Parameters<typeof userCaller>[1]): ReturnType<typeof userCaller> {
  return userCaller(user, options);
}

/** Use the same JSON fixture as ctx.props.mantle. */
export function hostAs(props: HostProps): ReturnType<typeof hostCaller> {
  const fields = Object.fromEntries(Object.entries(props?.user ?? {}).filter(([key]) => !["id", "role", "email", "name"].includes(key)).map(([key, value]) => [key, { type: typeof (Array.isArray(value) ? value[0] : value) === "number" ? "number" as const : "string" as const, multiple: true }]));
  return hostCaller(props, { tenant: props?.tenant, fields });
}
