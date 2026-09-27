/**
 * `infrastructure/cli/` — file-walking + console I/O adapters for
 * each subcommand. Thin: load files → call use case → format → stdout.
 */
export { loadManifestsFromRoot, type LoadManifestsResult } from "./loadManifests.js";
export { run as runValidate } from "./ValidateCommand.js";
export { run as runIntrospect } from "./IntrospectCommand.js";
export { run as runEmitOpenapi } from "./EmitOpenapiCommand.js";
export { run as runEmitTypes } from "./EmitTypesCommand.js";
