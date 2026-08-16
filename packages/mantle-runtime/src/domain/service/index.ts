/**
 * `domain/service/` — pure stateless algorithms operating on the
 * domain model + spec types. No env, no I/O.
 *
 * Services that coordinate I/O ports live in `./io/` and are imported
 * directly by their consumers — NOT re-exported here, so the barrel's
 * purity claim above holds.
 */
export * from "./LocaleNegotiator.js";
export * from "./Pagination.js";
export * from "./ViewParamCoercer.js";
export * from "./PathMatcher.js";
export * from "./TriggerIndex.js";
export * from "./RuntimePlanCompiler.js";
export * from "./BuiltinProjector.js";
export * from "./AuthPredicateEvaluator.js";
