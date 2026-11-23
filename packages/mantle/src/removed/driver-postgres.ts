/**
 * Removed-subpath stub (CONTRIBUTING.md, "Removed public subpaths"). The old names stay so an import links; evaluating the
 * module throws the message registered in removed-subpaths.json. Deleted with the first version after 0.2.2.
 */
const message =
  '@aotter/mantle/driver/postgres was removed in 0.2.2-alpha.2: instead of transaction, run your own SQL in store(db, caller).transaction((tx, db) => ...) (handbook concepts/runtime-and-adapters.md, "Your own SQL in a Store transaction"); regenerate generated code';
/** Every call is a type error; one with arguments names the message as the expected type. */
type Removed = (removed: typeof message, ...more: (typeof message)[]) => never;
/** @deprecated Removed in 0.2.2-alpha.2: use `store(db, caller).transaction((tx, db) => …)`. */
export let transaction: Removed;
/** @deprecated Removed in 0.2.2-alpha.2: generated-code plumbing; regenerate. */
export let read: Removed, run: Removed, procedure: Removed, definitive: Removed, postgresOutcome: Removed;
throw new Error(message);
