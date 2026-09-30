// Every place a relation can be reached in the IR (ADR-0034 decision 8). The policy pass has ONE
// function that prints a Schema reference, and it is handed one of these; the probe list in
// cases/policy.ts is a `Record<RelationPosition, Probe>` checked with `satisfies`, so a position
// added here without a probe fails `tsc`.
//
// The IR is the parser's AST and the AST does not say which keys can hold a relation, so this is
// the one hand-kept list. It is tied to @pgsql/types below: every edge names a real key of a real
// node type (a renamed key fails typecheck), and `policy.ts` fails closed on any relation reached
// through an edge that is not here.
import type { DeleteStmt, InsertStmt, JoinExpr, OnConflictClause, RangeSubselect, SelectStmt, SubLink, UpdateStmt } from '@pgsql/types';

type Edge<Name extends string, T, K extends keyof T & string> = `${Name}.${K}`;

/** the IR edges a RangeVar (or a compiler-emitted relation) hangs from */
export type RelationEdge =
  | Edge<'SelectStmt', SelectStmt, 'fromClause'>
  | Edge<'JoinExpr', JoinExpr, 'larg' | 'rarg'>
  | Edge<'RangeSubselect', RangeSubselect, 'subquery'>
  | Edge<'SubLink', SubLink, 'subselect'>
  | Edge<'InsertStmt', InsertStmt, 'relation' | 'selectStmt'>
  | Edge<'UpdateStmt', UpdateStmt, 'relation'>
  | Edge<'DeleteStmt', DeleteStmt, 'relation'>
  | Edge<'OnConflictClause', OnConflictClause, 'whereClause'>;

export type RelationPosition =
  | 'from' // a Schema in the FROM of the statement itself
  | 'join.left'
  | 'join.right'
  | 'from-subquery' // inside `FROM (SELECT ...) alias`
  | 'sublink' // inside IN (subquery), EXISTS (subquery) or a scalar subquery
  | 'json_each' // `FROM t, json_each(t.col)`: the unwind reads a column of a wrapped relation
  | 'window' // a select that feeds a window function
  | 'insert-target' // the row being inserted: scope and system columns are filled
  | 'insert-select' // the SELECT of INSERT ... SELECT
  | 'update-target'
  | 'delete-target'
  | 'conflict-update' // ON CONFLICT ... DO UPDATE: the row being overwritten
  | 'search' // _mantle_fts_<schema>, emitted by the compiler for search()
  | 'near'; // _mantle_geo_<schema>_<field>, emitted by the compiler for near()

export const POSITION_EDGE = {
  from: 'SelectStmt.fromClause',
  'join.left': 'JoinExpr.larg',
  'join.right': 'JoinExpr.rarg',
  'from-subquery': 'RangeSubselect.subquery',
  sublink: 'SubLink.subselect',
  json_each: 'SelectStmt.fromClause',
  window: 'SelectStmt.fromClause',
  'insert-target': 'InsertStmt.relation',
  'insert-select': 'InsertStmt.selectStmt',
  'update-target': 'UpdateStmt.relation',
  'delete-target': 'DeleteStmt.relation',
  'conflict-update': 'OnConflictClause.whereClause',
  search: 'compiler',
  near: 'compiler',
} as const satisfies Record<RelationPosition, RelationEdge | 'compiler'>;

/** Compile-time: every edge above is reached by at least one position, so an edge cannot exist without a probe. */
type Unreached = Exclude<RelationEdge, (typeof POSITION_EDGE)[RelationPosition]>;
export const ALL_EDGES_REACHED: [Unreached] extends [never] ? true : never = true;

export const ALL_POSITIONS = Object.keys(POSITION_EDGE) as RelationPosition[];
