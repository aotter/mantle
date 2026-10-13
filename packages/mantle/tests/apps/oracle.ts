/** Native oracle SQL is written with `?`; PostgreSQL numbers them. */
export function postgresOracleSql(sql: string) {
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}
