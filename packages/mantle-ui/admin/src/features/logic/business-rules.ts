import type { DeveloperAtom, DeveloperSchemaModel, SqlLogicNode } from '../../lib/types';
import type { AdminLanguage } from '../../app/preferences';
import { resolveLocalizedText } from '../../lib/localized-text';
import { enumOptions, moneyMinorHint } from '../../../../src/react/values';

export interface BusinessRule {
  kind: 'operation' | 'case';
  statement: number;
  title: string;
  body: string;
  summary: string;
  field?: string;
  conditions?: string;
  assignments?: string[];
  transitions?: Array<{ schema: string; field: string; from: string; to: string[] }>;
  branches?: Array<{ condition: string; value: string }>;
  otherwise?: string;
}

/** UI wording is structural; domain names and option meanings belong to the manifest. */
export function businessRules(atom: DeveloperAtom, schemas: readonly DeveloperSchemaModel[], language: AdminLanguage): BusinessRule[] {
  if (atom.handler?.kind !== 'sql') return [];
  const zh = language.startsWith('zh');
  return (atom.handler.flow ?? []).flatMap((statement) => {
    const model = schemas.find((s) => s.name.toLowerCase() === statement.table?.toLowerCase());
    const name = model ? resolveLocalizedText(model.title, language) : statement.table;
    const fields = model?.schema.properties ?? {};
    const fieldSchema = (name: string) => {
      const key = Object.keys(fields).find((key) => key.toLowerCase() === name.toLowerCase());
      return key === undefined ? undefined : fields[key];
    };
    const fieldTitle = (name: string) => resolveLocalizedText(fieldSchema(name)?.title ?? null, language) || name;
    const unknown = zh ? '此條件尚無業務翻譯，請查看程式依據' : 'Business wording unavailable; inspect source';
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
        const title = resolveLocalizedText(atom.input?.properties?.[key]?.title ?? null, language);
        return `${zh ? '本次輸入' : 'Input'}${title ? `「${title}」` : ''}`;
      }
      if (n.column && ['id', 'version'].includes(n.column.name.toLowerCase())) return zh ? n.column.name.toLowerCase() === 'id' ? '資料識別碼' : '資料版本' : n.column.name.toLowerCase() === 'id' ? 'Record ID' : 'Record version';
      if (n.label === 'auth.uid' && n.kind === 'function') return zh ? '目前使用者的識別碼' : 'Current user ID';
      if (n.kind === 'expression' && children.length === 2) {
        const operators: Record<string, string> = zh ? { '<': '小於', '>': '大於', '<=': '小於或等於', '>=': '大於或等於', '=': '等於', '<>': '不等於' } : { '<': 'is less than', '>': 'is greater than', '<=': 'is at most', '>=': 'is at least', '=': 'equals', '<>': 'differs from' };
        if (operators[n.label]) { const left = n.children[0]!; const rightNode = n.children[1]!; const leftProp = property(left, scope); const right = rightNode.kind === 'value' && /^'.*'$/.test(rightNode.label) && leftProp ? enumValue(leftProp.schema, rightNode.label, language) : expr(rightNode, leftProp?.key ?? left.label, scope); return children[0] === unknown || right === unknown ? unknown : `${children[0]} ${operators[n.label]} ${right}`; }
      }
      if (n.kind === 'predicate' && /^(AND|OR) ·/.test(n.label)) return `${zh ? n.label.startsWith('AND') ? '全部條件成立' : '至少一個條件成立' : n.label.startsWith('AND') ? 'All conditions' : 'Any condition'}：\n${children.join('\n')}`;
      if (n.label === 'Condition') return children.join('\n');
      if (n.kind === 'predicate' && n.label === 'NOT') return `${zh ? '以下條件不成立' : 'Not'}：（${children.join('、')}）`;
      if (n.kind === 'predicate' && ['IS NULL', 'IS NOT NULL', 'IS TRUE', 'IS FALSE', 'IS NOT TRUE', 'IS NOT FALSE', 'IS UNKNOWN', 'IS NOT UNKNOWN'].includes(n.label)) {
        const wording: Record<string, string> = { 'IS NULL': '為空值', 'IS NOT NULL': '不是空值', 'IS TRUE': '為真', 'IS FALSE': '為假', 'IS NOT TRUE': '不為真（含未知）', 'IS NOT FALSE': '不為假（含未知）', 'IS UNKNOWN': '為未知', 'IS NOT UNKNOWN': '不是未知' };
        return `${children[0]} ${zh ? wording[n.label] : n.label}`;
      }
      if (n.kind === 'expression' && ['+', '-', '*', '/'].includes(n.label) && children.length === 2) return `（${children[0]} ${n.label} ${children[1]}）`;
      if (n.kind === 'value' && ['TRUE', 'FALSE'].includes(n.label)) return zh ? n.label === 'TRUE' ? '是' : '否' : n.label === 'TRUE' ? 'Yes' : 'No';
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
        return `${zh ? '從' : 'From'} ${tableNames.join('、')}${columns?.length ? `${zh ? ' 讀取' : ' read'} ${columns.join('、')}` : ''}${filter || joinConditions.length ? `；${[...joinConditions, ...(filter ? [expr(filter, undefined, scope)] : [])].join('；')}` : ''}`;
      }
      if (n.kind === 'subquery' && ['EXISTS', 'EXPR'].includes(n.label)) return `${n.label === 'EXISTS' ? zh ? '存在符合以下條件的資料' : 'Matching data exists' : zh ? '查得的值' : 'Selected value'}：
${children.join('\n')}`;
      if (n.kind === 'value' && n.label === 'NULL') return zh ? '空值' : 'Empty value';
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
          return `${n.label} (${zh ? 'SQL 原值' : 'raw SQL value'})`;
        }
        return n.label;
      }
      if (n.kind === 'value' && /^'.*'$/.test(n.label)) {
        const value = n.label.slice(1, -1).replace(/''/g, "'");
        const options = (enumOptions(field ? fieldSchema(field) : undefined) ?? []).filter((o) => o.value === value && o.title);
        if (options.length === 1) return resolveLocalizedText(options[0]!.title!, language) || value;
        return `「${value}」`;
      }
      return unknown;
    };
    const operation = ({ UPDATE: zh ? '更新' : 'Update', INSERT: zh ? '新增' : 'Create', DELETE: zh ? '刪除' : 'Delete', SELECT: zh ? '讀取' : 'Read' } as Record<string, string>)[statement.operation] ?? (zh ? '處理' : 'Process');
    const tree = statement.logic;
    const where = tree?.children.find((c) => c.label.startsWith('WHERE'));
    const outputs = tree?.children.find((c) => c.label === 'SET')?.children ?? [];
    const filter = where?.children[0];
    const conditionCount = filter?.label.startsWith('AND') || filter?.label.startsWith('OR') ? filter.children.length : filter ? 1 : 0;
    const summary = outputs.length ? `${zh ? '設定' : 'Set'}：${outputs.map((o) => fieldTitle(o.label)).slice(0, 2).join('、')}${outputs.length > 2 ? (zh ? '等欄位' : '…') : ''}` : conditionCount ? (zh ? `篩選資料：${conditionCount} 項條件` : `Filter: ${conditionCount} conditions`) : '';
    const conditions = where?.children[0] ? expr(where.children[0]) : '';
    const assignments = outputs.map((o) => `${fieldTitle(o.label)} ← ${o.children[0]?.kind === 'case' ? zh ? '依下方規則決定' : 'Chosen by the rule below' : expr(o.children[0] ?? o, o.label)}`);
    const checks = (model?.checks ?? []).map((c) => expr(c, undefined, new Map(model ? [[model.name.toLowerCase(), model]] : [])));
    const rules: BusinessRule[] = [{ kind: 'operation', statement: statement.index, summary, conditions, assignments, title: `${operation} ${name || (zh ? '資料' : 'data')}`, body: [conditions, assignments.join('\n'), checks.length ? `${zh ? '資料限制（不成立時整批不保存；空值依 SQL 規則）' : 'Data constraints (failure rolls back the batch)'}：\n${checks.join('\n')}` : '', statement.mode === 'row' ? (zh ? '必須符合一筆資料；否則整批不寫入' : 'Exactly one affected row; otherwise the batch rolls back') : statement.mode === 'set' ? (zh ? '可能符合多筆；零筆符合時仍繼續' : 'May affect multiple rows; zero matches still continues') : ''].filter(Boolean).join('\n') }];
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
          kind: 'case', statement: statement.index, field: field ? fieldTitle(field) : undefined, summary: zh ? '依順序選擇第一個成立的結果' : 'First matching result in order',
          branches: n.children.filter((c) => c.kind === 'when').map((c) => {
            const condition = c.children[0]!;
            return { condition: expr(selector ? { kind: 'expression', label: '=', children: [selector, condition.children[0] ?? condition] } : condition), value: expr(c.children[1]?.children[0] ?? c, field) };
          }),
          otherwise: expr(n.children.find((c) => c.label === 'ELSE')?.children[0] ?? { kind: 'value', label: 'NULL', children: [] }, field),
          title: zh ? `決定${field ? `「${fieldTitle(field)}」` : '欄位值'}` : `Choose ${field ? fieldTitle(field) : 'a value'}`,
          body: n.children.filter((c) => c.label !== 'Value').map((c) => {
            if (c.kind === 'when') {
              const condition = c.children[0]!;
              const comparison: SqlLogicNode = selector ? { kind: 'expression', label: '=', children: [selector, condition.children[0] ?? condition] } : condition;
              return `${c.label.replace('WHEN', zh ? '條件' : 'Condition')}：${expr(comparison)}\n${zh ? '結果' : 'Result'}：${expr(c.children[1]?.children[0] ?? c, field)}`;
            }
            return c.label === 'ELSE' ? `${zh ? '其他情況（含未成立或未知）' : 'Otherwise (including false or unknown)'}：${expr(c.children[0] ?? c, field)}` : expr(c);
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
  return resolveLocalizedText(title ?? null, language) || `「${value}」`;
}
