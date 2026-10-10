// Ref handlers of the fixture. They MUST NOT import @aotter/mantle: they only use the HandlerContext they are handed.
// Several Views are combined per call, as Swolhalla's report procedures do.
const total = (results) => results.map((r) => r.rows.length);

export const handlers = {
  async trainingReport(input, ctx) {
    const results = await Promise.all([
      ctx.store.view("weekly-volume"),
      ctx.store.view("personal-records"),
      ctx.store.view("exercise-history", { input: { exercise: input.exercise } }),
      ctx.store.view("training-summary", { input: { since: input.since } }),
      ctx.store.view("workout-list", { limit: 20 }),
    ]);
    return { counts: total(results) };
  },
  async checkinWall(input, ctx) {
    const results = [
      await ctx.store.view("workout-list", { limit: 10 }),
      await ctx.store.view("workout-sets", { input: { workoutId: input.workoutId }, limit: 200 }),
      await ctx.store.view("personal-records", { limit: 10 }),
      // a dynamic Store read: it builds new IR on every call
      await ctx.store.select({ from: "sets", columns: ["exercise", "weightKg", "reps"], where: { workoutId: input.workoutId, tag: "working" }, orderBy: { position: "asc" }, limit: 100 }),
    ];
    return { counts: total(results) };
  },
};
