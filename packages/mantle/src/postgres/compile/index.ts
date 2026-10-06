/**
 * `@aotter/mantle/postgres/compile`: the PostgreSQL dialect's compile side (ADR-0035 decision 3). Loaded only by the CLI, after
 * the shared front end has parsed the source and tagged its relations. `accepts` throws the first refusal with its offset.
 */
/** The PostgreSQL dialect as a plan records it (ADR-0035 decision 5). `version` changes when what a PostgreSQL plan means changes. */
export const name = "@aotter/mantle/postgres";
export const version = "1";
export { validateProgram as accepts } from "../validator.js";
