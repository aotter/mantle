/**
 * Removed-subpath stub (CONTRIBUTING.md, "Removed public subpaths"). The old names stay so an import links; evaluating the
 * module throws the message registered in removed-subpaths.json. Deleted with the first version after 0.2.2.
 */
const message =
  '@aotter/mantle/surface was removed in 0.2.2-alpha.2: instead of convert, use convertInput and the Conversions type from @aotter/mantle/contracts; instead of invalid, throw new ContractError("INPUT_VALIDATION_FAILED", message, path) from there; decode has no replacement';
/** Every call is a type error; one with arguments names the message as the expected type. */
type Removed = (removed: typeof message, ...more: (typeof message)[]) => never;
/** @deprecated Removed in 0.2.2-alpha.2: use `convertInput` from `@aotter/mantle/contracts`. */
export let convert: Removed;
/** @deprecated Removed in 0.2.2-alpha.2: throw `ContractError` from `@aotter/mantle/contracts`. */
export let invalid: Removed;
/** @deprecated Removed in 0.2.2-alpha.2: no replacement. */
export let decode: Removed;
/** @deprecated Removed in 0.2.2-alpha.2: use `Conversions` from `@aotter/mantle/contracts`. A value of this type shows the message. */
export type Conversions = typeof message;
throw new Error(message);
