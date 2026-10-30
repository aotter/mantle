import type { DeveloperAtom, DeveloperSchemaModel, SqlLogicNode } from '../../lib/types';
import type { AdminLanguage } from '../../app/preferences';
import { resolveLocalizedText } from '../../lib/localized-text';
import { t, type I18nKey } from '../../app/i18n';
import { enumOptions, moneyMinorHint } from '@aotter/mantle-ui';

export interface BusinessRule {
  kind: 'operation' | 'case';
  statement: number;
  /** Row rule of an operation: `row` must affect exactly one row, `set` zero or more, `read` returns rows. */
  mode?: 'read' | 'row' | 'set';
  /** Schema checks a write must keep; a violation rolls the batch back. */
  checks?: string[];
  title: string;
  body: string;
  summary: string;
  field?: string;
  /** The WHERE as separate conditions; `joiner` names the AND/OR that combines them. */
  where?: { joiner?: string; items: string[] };
  assignments?: string[];
  transitions?: Array<{ schema: string; field: string; from: string; to: string[] }>;
  branches?: Array<{ condition: string; value: string }>;
  otherwise?: string;
}

/** UI wording is structural; domain names and option meanings belong to the manifest. */
export function businessRules(atom: DeveloperAtom, schemas: readonly DeveloperSchemaModel[], language: AdminLanguage): BusinessRule[] {
  if (atom.handler?.kind !== 'sql') return [];
  const say = (key: string, vars?: Record<string, string>) => t(language, `developer.logic.${key}` as I18nKey, vars);
  const list = (items: string[]) => items.join(say('listSeparator'));
  const quote = (value: string) => say('quote', { value });
  const labeled = (label: string, value: string) => say('labeled', { label, value });
  const heading = (label: string, lines: string[]) => [say('heading', { label }), ...lines].join('\n');
  return (atom.handler.flow ?? []).flatMap((statement) => {
    const model = schemas.find((s) => s.name.toLowerCase() === statement.table?.toLowerCase());
    const name = model ? resolveLocalizedText(model.title, language) : statement.table;
    const fields = model?.schema.properties ?? {};
    const fieldSchema = (name: string) => {
      const key = Object.keys(fields).find((key) => key.toLowerCase() === name.toLowerCase());
      return key === undefined ? undefined : fields[key];
    };
    const fieldTitle = (name: string) => resolveLocalizedText(fieldSchema(name)?.title ?? null, language) || Object.keys(fields).find((key) => key.toLowerCase() === name.toLowerCase()) || name;
    const unknown = say('unknown');
    // Each SELECT has its own relation scope. Aliases may shadow outer aliases.
    type Scope = Map<string, DeveloperSchemaModel | undefined>;
    const localScopes = new WeakMap<Scope, string[]>();
    const scopeFor = (n: SqlLogicNode, parent: Scope): Scope => {
      const scope = new Map(parent);
      const local: string[] = [];
      const tables = (node: SqlLogicNode) => {
        if (node.relation) { const r = node.relation; local.push((r.alias ?? r.name).toLowerCase()); scope.set((r.alias ?? r.name).toLowerCase(), schemas.find((s) => s.name.toLowerCase() === r.name.toLowerCase())); }
        if (node !== n && (node.kind === 'statement' || node.kind === 'subquery' || node.kind === 'cte')) return;
        node.children.forEach(tables);
      };
      tables(n);
      localScopes.set(scope, local);
      return scope;
    };
    const rootScope = scopeFor(statement.logic ?? { kind: '', label: '', children: [] }, new Map());
    const property = (n: SqlLogicNode, scope: Scope) => {
      const column = n.column ?? (n.kind === 'value' && fieldSchema(n.label) ? { name: n.label } : undefined);
      if (!column || column.relation === 'input') return undefined;
      const candidates = column.relation ? [scope.get(column.relation.toLowerCase()) ?? schemas.find((s) => s.name.toLowerCase() === column.relation!.toLowerCase())] : (localScopes.get(scope)?.length ? localScopes.get(scope)!.map((key) => scope.get(key)) : [...scope.values()]);
      const matches = candidates.flatMap((s) => {
        if (!s) return [];
        const key = Object.keys(s.schema.properties ?? {}).find((k) => k.toLowerCase() === column.name.toLowerCase());
        return key ? [{ key, model: s, schema: s.schema.properties![key]! }] : [];
      });
      return matches.length === 1 ? matches[0] : !column.relation && !scope.size && fieldSchema(column.name) ? { key: column.name, model: model!, schema: fieldSchema(column.name)! } : undefined;
    };
    const expr = (n: SqlLogicNode, field?: string, parent: Scope = rootScope): string => {
      const scope = n.kind === 'statement' ? scopeFor(n, parent) : parent;
      const children = n.children.map((child) => expr(child, field, scope));
      const prop = property(n, scope);
      if (prop) return `${n.column?.relation ? `${resolveLocalizedText(prop.model.title, language)} · ` : ''}${resolveLocalizedText(prop.schema.title ?? null, language) || prop.key}`;
      if (n.column?.relation === 'input' || n.kind === 'value' && n.label.startsWith('input.')) {
        const key = n.column?.name ?? n.label.slice(6);
        const inputKey = Object.keys(atom.input?.properties ?? {}).find((name) => name.toLowerCase() === key.toLowerCase());
        const title = resolveLocalizedText(inputKey ? atom.input?.properties?.[inputKey]?.title ?? null : null, language);
        return title ? say('inputNamed', { name: quote(title) }) : say('input');
      }
      if (n.column && ['id', 'version'].includes(n.column.name.toLowerCase())) return say(n.column.name.toLowerCase() === 'id' ? 'recordId' : 'recordVersion');
      if (n.label === 'auth.uid' && n.kind === 'function') return say('currentUser');
      if (n.kind === 'expression' && children.length === 2) {
        const operator = ({ '<': 'lt', '>': 'gt', '<=': 'lte', '>=': 'gte', '=': 'eq', '<>': 'ne' } as Record<string, string>)[n.label];
        if (operator) { const left = n.children[0]!; const rightNode = n.children[1]!; const leftProp = property(left, scope); const right = rightNode.kind === 'value' && /^'.*'$/.test(rightNode.label) && leftProp ? enumValue(leftProp.schema, rightNode.label, language) : expr(rightNode, leftProp?.key ?? left.label, scope); return children[0] === unknown || right === unknown ? unknown : `${children[0]} ${say(`op.${operator}`)} ${right}`; }
      }
      if (n.kind === 'predicate' && /^(AND|OR) ·/.test(n.label)) return heading(say(n.label.startsWith('AND') ? 'all' : 'any'), children);
      if (n.label === 'Condition') return children.join('\n');
      if (n.kind === 'predicate' && n.label === 'NOT') return say('not', { conditions: list(children) });
      if (n.kind === 'predicate' && ['IS NULL', 'IS NOT NULL', 'IS TRUE', 'IS FALSE', 'IS NOT TRUE', 'IS NOT FALSE', 'IS UNKNOWN', 'IS NOT UNKNOWN'].includes(n.label)) {
        const key = n.label.slice(3).toLowerCase().replace(/ (\w)/g, (_, c: string) => c.toUpperCase());
        return `${children[0]} ${say(`is.${key}`)}`;
      }
      if (n.kind === 'expression' && ['+', '-', '*', '/'].includes(n.label) && children.length === 2) return `(${children[0]} ${n.label} ${children[1]})`;
      if (n.kind === 'value' && ['TRUE', 'FALSE'].includes(n.label)) return say(n.label === 'TRUE' ? 'yes' : 'no');
      if (n.kind === 'statement' && n.label === 'SELECT') {
        const sources = n.children.find((c) => c.label === 'FROM');
        const tableNames: string[] = [];
        const joinConditions: string[] = [];
        let unsupportedJoin = false;
        const source = (c: SqlLogicNode) => {
          if (c.relation) tableNames.push(resolveLocalizedText(scope.get((c.relation.alias ?? c.relation.name).toLowerCase())?.title ?? null, language) || c.relation.name);
          if (c.kind === 'statement' || c.kind === 'subquery') return;
          if (c.kind === 'join' && (c.label !== 'INNER JOIN' || c.children.some((child) => child.label === 'USING'))) unsupportedJoin = true;
          if (c.label === 'ON') joinConditions.push(expr(c.children[0]!, undefined, scope));
          c.children.forEach(source);
        };
        sources?.children.forEach(source);
        const filter = n.children.find((c) => c.label.startsWith('WHERE'))?.children[0];
        const columns = n.children.find((c) => c.label === 'SELECT')?.children.map((c) => expr(c.children[0] ?? c, undefined, scope));
        if (unsupportedJoin || !tableNames.length || n.children.some((c) => ['WITH', 'WITH RECURSIVE', 'GROUP BY', 'HAVING · keep TRUE groups', 'LIMIT', 'DISTINCT', 'DISTINCT ON'].includes(c.label) || c.kind === 'set')) return unknown;
        const from = columns?.length ? say('fromRead', { tables: list(tableNames), columns: list(columns) }) : say('from', { tables: list(tableNames) });
        return filter || joinConditions.length ? labeled(from, list([...joinConditions, ...(filter ? [expr(filter, undefined, scope)] : [])])) : from;
      }
      if (n.kind === 'subquery' && ['EXISTS', 'EXPR'].includes(n.label)) return heading(say(n.label === 'EXISTS' ? 'exists' : 'selected'), children);
      if (n.kind === 'value' && n.label === 'NULL') return say('empty');
      if (n.kind === 'value' && /^-?\d+(\.\d+)?$/.test(n.label)) {
        if (field && moneyMinorHint(fieldSchema(field))) {
          // A SQL threshold must never be rounded by Number or currency display rules.
          const value = Number(n.label);
          if (/^-?\d+$/.test(n.label) && Number.isSafeInteger(value)) {
            const digits = String(Math.abs(value)).padStart(3, '0');
            const exact = `${value < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
            const currencies = enumOptions(fieldSchema('currency'));
            const currency = currencies?.length === 1 ? currencies[0]!.value : undefined;
            let formatter: Intl.NumberFormat;
            try { formatter = new Intl.NumberFormat(undefined, currency ? { style: 'currency', currency } : {}); }
            catch { formatter = new Intl.NumberFormat(); }
            const parts = formatter.formatToParts(value / 100);
            const rendered = `${parts.some((p) => p.type === 'minusSign') ? '-' : ''}${parts.filter((p) => p.type === 'integer').map((p) => p.value).join('')}.${parts.find((p) => p.type === 'fraction')?.value ?? ''}`;
            if (rendered.replace(/0+$/, '') === exact.replace(/0+$/, '')) return formatter.format(value / 100);
          }
          return say('raw', { value: n.label });
        }
        return n.label;
      }
      if (n.kind === 'value' && /^'.*'$/.test(n.label)) {
        const value = n.label.slice(1, -1).replace(/''/g, "'");
        const options = (enumOptions(field ? fieldSchema(field) : undefined) ?? []).filter((o) => o.value === value && o.title);
        if (options.length === 1) return resolveLocalizedText(options[0]!.title!, language) || value;
        return quote(value);
      }
      return unknown;
    };
        const tree = statement.logic;
    const where = tree?.children.find((c) => c.label.startsWith('WHERE'));
    const columns = tree?.children.find((c) => c.label === 'Columns')?.children ?? [];
    const select = tree?.children.find((c) => c.label === 'Source SELECT')?.children[0];
    const values = select?.children.find((c) => c.label === 'VALUES')?.children;
    const row = values?.length === 1 ? values[0]?.children : select?.children.find((c) => c.label === 'SELECT')?.children.map((c) => c.children[0]);
    const inserted = columns.length && row?.length === columns.length ? columns.map((column, i) => ({ ...column, children: row[i] ? [row[i]!] : [] })) : [];
    const outputs = tree?.children.find((c) => c.label === 'SET')?.children ?? inserted;
    const assignmentScope = statement.operation === 'INSERT' && select ? scopeFor(select, rootScope) : rootScope;
    const filter = where?.children[0];
    const conditionCount = filter?.label.startsWith('AND') || filter?.label.startsWith('OR') ? filter.children.length : filter ? 1 : 0;
    const shown = list(outputs.map((o) => fieldTitle(o.label)).slice(0, 2));
    const summary = outputs.length ? say('sets', { fields: outputs.length > 2 ? say('more', { fields: shown }) : shown }) : conditionCount ? say('filter', { count: String(conditionCount) }) : '';
    const conditions = filter ? expr(filter) : '';
    const joined = filter?.kind === 'predicate' && /^(AND|OR) ·/.test(filter.label);
    const whereItems = filter ? { joiner: joined ? say(filter.label.startsWith('AND') ? 'all' : 'any') : undefined, items: joined ? filter.children.map((c) => expr(c)) : [conditions] } : undefined;
    const assignments = outputs.map((o) => `${fieldTitle(o.label)} ← ${o.children[0]?.kind === 'case' ? say('chosenBelow') : expr(o.children[0] ?? o, o.label, assignmentScope)}`);
    const checks = (model?.checks ?? []).map((c) => expr(c, undefined, new Map(model ? [[model.name.toLowerCase(), model]] : [])));
    const rules: BusinessRule[] = [{ kind: 'operation', statement: statement.index, mode: statement.mode, checks, summary, where: whereItems, assignments, title: say(`verb.${['UPDATE', 'INSERT', 'DELETE', 'SELECT'].includes(statement.operation) ? statement.operation : 'other'}`, { name: name || say('data') }), body: [conditions, assignments.join('\n'), checks.length ? heading(say('constraints'), checks) : '', statement.mode === 'row' ? say('rowRule') : statement.mode === 'set' ? say('setRule') : ''].filter(Boolean).join('\n') }];
    if (model && statement.mode === 'row' && statement.operation === 'UPDATE' && filter) {
      const predicates = (n: SqlLogicNode): SqlLogicNode[] => n.kind === 'predicate' && n.label.startsWith('AND ·') ? n.children.flatMap(predicates) : [n];
      rules[0]!.transitions = outputs.flatMap((output) => {
        const field = Object.keys(fields).find((k) => k.toLowerCase() === output.label.toLowerCase());
        if (!field) return [];
        const options = enumOptions(fields[field]);
        if (!options) return [];
        const literal = (n: SqlLogicNode | undefined) => n?.kind === 'value' && /^'.*'$/.test(n.label) && !n.column ? n.label.slice(1, -1).replace(/''/g, "'") : undefined;
        const equals = predicates(filter).filter((n) => n.kind === 'expression' && n.label === '=' && n.children.length === 2).flatMap((n) => {
          const a = n.children[0]!, b = n.children[1]!;
          const col = property(a, rootScope), reversed = property(b, rootScope);
          return col?.model === model && col.key === field && literal(b) !== undefined ? [literal(b)!] : reversed?.model === model && reversed.key === field && literal(a) !== undefined ? [literal(a)!] : [];
        });
        const value = output.children[0];
        const targets = value?.kind === 'case' ? value.children.filter((c) => c.kind === 'when' || c.label === 'ELSE').map((c) => literal(c.kind === 'when' ? c.children[1]?.children[0] : c.children[0])) : [literal(value)];
        if (equals.length !== 1 || !targets.length || targets.some((v) => v === undefined || !options.some((o) => o.value === v)) || !options.some((o) => o.value === equals[0])) return [];
        return [{ schema: model.name, field, from: equals[0]!, to: [...new Set(targets as string[])] }];
      });
    }
    const cases = (n: SqlLogicNode, field?: string) => {
      if (n.kind === 'case') {
        const selector = n.children.find((c) => c.label === 'Value')?.children[0];
        rules.push({
          kind: 'case', statement: statement.index, field: field ? fieldTitle(field) : undefined, summary: say('caseSummary'),
          branches: n.children.filter((c) => c.kind === 'when').map((c) => {
            const condition = c.children[0]!;
            return { condition: expr(selector ? { kind: 'expression', label: '=', children: [selector, condition.children[0] ?? condition] } : condition, undefined, assignmentScope), value: expr(c.children[1]?.children[0] ?? c, field, assignmentScope) };
          }),
          otherwise: expr(n.children.find((c) => c.label === 'ELSE')?.children[0] ?? { kind: 'value', label: 'NULL', children: [] }, field, assignmentScope),
          title: field ? say('choose', { field: quote(fieldTitle(field)) }) : say('chooseValue'),
          body: n.children.filter((c) => c.label !== 'Value').map((c) => {
            if (c.kind === 'when') {
              const condition = c.children[0]!;
              const comparison: SqlLogicNode = selector ? { kind: 'expression', label: '=', children: [selector, condition.children[0] ?? condition] } : condition;
              return `${labeled(c.label.replace('WHEN', say('condition')), expr(comparison, undefined, assignmentScope))}\n${labeled(say('result'), expr(c.children[1]?.children[0] ?? c, field, assignmentScope))}`;
            }
            return c.label === 'ELSE' ? labeled(say('otherwise'), expr(c.children[0] ?? c, field, assignmentScope)) : expr(c);
          }).join('\n'),
        });
      }
    };
    // Wrapped CASE results are operands, not the values assigned to this field.
    outputs.forEach((output) => {
      const value = output.children[0];
      if (value?.kind === 'case') cases(value, output.label);
    });
    return rules;
  });
}

function enumValue(schema: import('../../lib/types').JsonSchema, literal: string, language: AdminLanguage): string {
  const value = literal.slice(1, -1).replace(/''/g, "'");
  const title = enumOptions(schema)?.find((o) => o.value === value)?.title;
  return resolveLocalizedText(title ?? null, language) || t(language, 'developer.logic.quote', { value });
}
