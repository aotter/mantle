/** Index declarations shared by the native initial schema printers. */
import type { StorageSchema } from "../dialect.js";
export const indexDefinitions = (name: string, s: StorageSchema) => [
  ...(s.unique ?? []).map((u, i) => ({
    name: `_mantle_uq_${name}_${i}`,
    unique: true,
    columns: s.userScopes?.length
      ? [...new Set([...(s.scope ? [s.scope] : []), ...s.userScopes.map(x => x.column), ...u])]
      : s.scope && u[0] !== s.scope
        ? [s.scope, ...u]
        : [...u],
  })),
  ...(s.indexes ?? []).map((cols, i) => ({ name: `_mantle_ix_${name}_${i}`, unique: false, columns: cols })),
];
