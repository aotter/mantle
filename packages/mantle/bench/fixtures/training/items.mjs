// Bench items. Each is { name, kind, caller, minRows, zeroWarm, zeroFirst, samples?, warmup?, coldSamples?, prepare?, call, rows }.
//   call(ctx, args)   ctx = { runtime, store, caller, fixture }; `store` is runtime.store.as(caller, { kind: "internal", id: "bench" })
//   prepare(ctx)      optional; returns JSON-serializable `args`; runs once, outside every measurement
//   rows(result)      the number of rows the call produced (guards a scope or seed bug making Mantle look fast)
//   zeroWarm          counter keys that must be 0 on a warm call (check mode fails otherwise)
//   zeroFirst         counter keys that must be 0 on the first call (empty today; the generate-time lowering work sets it)
// Items do not import Mantle.
const ALL = ["compile", "check", "policy", "paged", "print", "zod", "storeIr"];
const CAUSE = { kind: "internal", id: "bench" };

const rowsOf = (page) => page.rows.length;
const countsOf = (result) => result.counts.reduce((a, b) => a + b, 0);

const view = (name, options, extra = {}) => ({
  name: `view:${name}${extra.suffix ?? ""}`, kind: "view", caller: "member", minRows: 1, zeroWarm: ALL, zeroFirst: [],
  call: (ctx, args) => ctx.store.view(name, typeof options === "function" ? options(ctx, args) : options), rows: rowsOf, ...extra.item,
});

export default [
  view("workout-list", { limit: 20 }, { suffix: ":first" }),
  {
    ...view("workout-list", (_ctx, args) => ({ limit: 20, cursor: args.cursor }), { suffix: ":page-5" }),
    async prepare(ctx) {
      let cursor;
      for (let i = 0; i < 4; i++) cursor = (await ctx.store.view("workout-list", { limit: 20, ...(cursor ? { cursor } : {}) })).nextCursor;
      return { cursor };
    },
  },
  view("workout-sets", (ctx) => ({ input: { workoutId: ctx.fixture.latestWorkoutId }, limit: 200 })),
  view("personal-records", { limit: 50 }),
  view("exercise-history", (ctx) => ({ input: { exercise: ctx.fixture.exercise }, limit: 100 })),
  // date_trunc('week') and a grouped paged View are the slow shapes on SQLite (#1291): fewer samples keep the run bounded
  view("weekly-volume", { limit: 50 }, { item: { samples: 20, warmup: 3, coldSamples: 4 } }),
  {
    name: "view:weekly-volume:all-pages", kind: "view", caller: "member", minRows: 1, zeroWarm: ALL, zeroFirst: [], samples: 20, warmup: 3, coldSamples: 3,
    async call(ctx) {
      let total = 0;
      for (let cursor, i = 0; i < 20; i++) {
        const page = await ctx.store.view("weekly-volume", { limit: 50, ...(cursor ? { cursor } : {}) });
        total += page.rows.length;
        if (!(cursor = page.nextCursor)) break;
      }
      return { rows: total };
    },
    rows: (result) => result.rows,
  },
  view("training-summary", (ctx) => ({ input: { since: ctx.fixture.since }, limit: 100 })),
  {
    name: "procedure:training-report", kind: "procedure-ref", caller: "member", minRows: 1, zeroWarm: ALL, zeroFirst: [], samples: 40, warmup: 5, coldSamples: 4,
    call: (ctx) => ctx.runtime.invokeProcedure({ procedure: "training-report", input: { since: ctx.fixture.since, exercise: ctx.fixture.exercise }, caller: ctx.caller, cause: CAUSE }),
    rows: countsOf,
  },
  {
    // zeroWarm is empty until Store.select stops rebuilding IR on every call (#1432)
    name: "procedure:checkin-wall", kind: "procedure-ref", caller: "member", minRows: 1, zeroWarm: [], zeroFirst: [],
    call: (ctx) => ctx.runtime.invokeProcedure({ procedure: "checkin-wall", input: { workoutId: ctx.fixture.latestWorkoutId }, caller: ctx.caller, cause: CAUSE }),
    rows: countsOf,
  },
  {
    // an UPDATE plus the _mantle_assert insert; "idempotent" means the same row counts each time, not the same bytes (version and updated_at move)
    name: "procedure:set-duration", kind: "procedure-inline", caller: "member", minRows: 0, zeroWarm: ALL, zeroFirst: [],
    call: (ctx) => ctx.runtime.invokeProcedure({ procedure: "set-duration", input: { workoutId: ctx.fixture.latestWorkoutId, durationMin: 60 }, caller: ctx.caller, cause: CAUSE }),
    rows: () => 0,
  },
  {
    name: "select:sets-by-workout", kind: "select", caller: "member", minRows: 1, zeroWarm: [], zeroFirst: [],
    call: (ctx) => ctx.store.select({ from: "sets", columns: ["exercise", "weightKg", "reps"], where: { workoutId: ctx.fixture.latestWorkoutId, tag: "working" }, orderBy: { position: "asc" }, limit: 100 }),
    rows: rowsOf,
  },
];
