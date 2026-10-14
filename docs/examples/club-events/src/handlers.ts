import { ContractError } from "@aotter/mantle/contracts";
import type { Handlers } from "../generated/generated.js";

export const handlers: Handlers = {
  register: async ({ caller, store }, { eventId }) => {
    if (caller.kind !== "user") throw new ContractError("AUTH_DENIED", "Sign in as a member to register.", "procedures/register");
    // Check before writing: a clear refusal for a missing or closed event. Seats are NOT checked here;
    // the `seats_left >= 0` check in register-write is what holds under concurrent requests.
    const event = await store.collection("events").findById(eventId);
    if (!event) throw new ContractError("NOT_FOUND", "No such event.", "procedures/register");
    if (event.closed) throw new ContractError("CONFLICT", "Registration for this event is closed.", "procedures/register");
    try {
      // `member` comes from the verified caller, never from request input; uniqueIndexes [eventId, member] refuses a second seat.
      return await store.procedures["register-write"]({ eventId, member: caller.subject });
    } catch (error) {
      if (String((error as Error)?.message).includes("MANTLE_CHECK events: seats_left >= 0"))
        throw new ContractError("CONFLICT", "The event is full.", "procedures/register");
      throw error;
    }
  },
};
