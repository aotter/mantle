# Deferred lifecycle hooks with Queues

This 0.1.x guide was removed in 0.2.0: no Mantle path produces queue messages.
After hooks run after the commit, best effort, with a stable `ctx.cause.id`;
see [Writes: Procedures, Triggers and hooks](handbook/concepts/procedures-and-triggers.md#lifecycle-hooks).
A service that needs a durable queue adds its own beside its Worker entry.
