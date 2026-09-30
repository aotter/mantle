/**
 * `@aotter/mantle/d1/compile`: the D1 dialect's compile side (ADR-0035 decision 3). Loaded only by the CLI, after the shared
 * front end has parsed the source and tagged its relations. `accepts` throws the first refusal (`SqlRefusal`, with its offset).
 */
export { validateProgram as accepts } from "../validator.js";
