import { ContractError } from "@aotter/mantle/contracts";
import { userOf } from "@aotter/mantle/auth";
import type { Handlers } from "../generated/generated.js";

export const handlers: Handlers = {
  register: async ({ caller, store }, { eventId, waitlist }) => {
    if (caller.kind !== "user") throw new ContractError("AUTH_DENIED", "Sign in as a member to register.", "procedures/register");
    // Check before writing: a clear refusal for a missing or closed event. Seats are NOT checked here;
    // the `seats_taken <= capacity` check in register-write is what holds under concurrent requests.
    const event = await store.collection("events").findById(eventId);
    if (!event) throw new ContractError("NOT_FOUND", "No such event.", "procedures/register");
    if (event.closed) throw new ContractError("CONFLICT", "Registration for this event is closed.", "procedures/register");
    // `member` comes from the verified caller, never from request input; uniqueIndexes [eventId, member] refuses a second seat.
    // userOf: the Better Auth user record the caller was resolved from (any credential), so officers see who registered.
    const user = userOf(caller), row = { eventId, member: caller.subject, memberName: user?.name || user?.email || caller.subject };
    try {
      return await store.procedures["register-write"](row);
    } catch (error) {
      // register-write's only Schema check is the capacity one.
      if (!(error instanceof ContractError && error.code === "CONFLICT" && error.fields?.kind === "check" && error.fields.schema === "events")) throw error;
      if (!waitlist) throw new ContractError("CONFLICT", "The event is full.", "procedures/register");
      // ponytail: a seat freed between the two calls stays unused until the next cancel promotes a waiter.
      return await store.procedures["waitlist-write"](row);
    }
  },
};
