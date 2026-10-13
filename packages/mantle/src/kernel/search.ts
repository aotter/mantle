/** Native substring predicates matching Core's mantle.search lowering. Values remain bound. */
export function searchLike(columns: readonly string[], query: string, operator: string): string {
  const pattern = `'%' || replace(replace(replace(${query}, '!', '!!'), '%', '!%'), '_', '!_') || '%'`;
  return columns.map(column => `${column} ${operator} ${pattern} ESCAPE '!'`).join(' OR ');
}
