/**
 * Removed-subpath stub (CONTRIBUTING.md, "Removed public subpaths"). The old names stay so an import links; evaluating the
 * module throws the message registered in removed-subpaths.json. Deleted with the first version after 0.2.2.
 */
const message = "@aotter/mantle/json-body was removed in 0.2.2-alpha.2: use body from @aotter/mantle/rest";
/** Every call is a type error; one with arguments names the message as the expected type. */
type Removed = (removed: typeof message, ...more: (typeof message)[]) => never;
/** @deprecated Removed in 0.2.2-alpha.2: use `body` from `@aotter/mantle/rest`. */
export let body: Removed;
/** @deprecated Removed in 0.2.2-alpha.2: use `body` from `@aotter/mantle/rest`. */
export let bytes: Removed;
throw new Error(message);
