import type { DeveloperAtom, DeveloperSchemaModel, SqlLogicNode } from '../../lib/types';
import type { AdminLanguage } from '../../app/preferences';
import { resolveLocalizedText } from '../../lib/localized-text';
import { enumOptions, moneyMinorHint, formatMoneyMinor } from '../../../../src/react/values';

export interface BusinessRule {
  kind: 'operation' | 'case';
  statement: number;
  title: string;
  body: string;
  summary: string;
  field?: string;
  branches?: Array<{ condition: string; value: string }>;
  otherwise?: string;
}

/** UI wording is structural; domain names and option meanings belong to the manifest. */
export function businessRules(atom: DeveloperAtom, schemas: readonly DeveloperSchemaModel[], language: AdminLanguage): BusinessRule[] {
  if (atom.handler?.kind !== 'sql') return [];
  const zh = language.startsWith('zh');
  return (atom.handler.flow ?? []).flatMap((statement) => {
    const model = schemas.find((s) => s.name === statement.table);
    const name = model ? resolveLocalizedText(model.title, language) : statement.table;
    const fields = model?.schema.properties ?? {};
    const fieldTitle = (name: string) => resolveLocalizedText(fields[name]?.title ?? null, language) || name;
    const unknown = zh ? '其他程式條件或值（查看詳情）' : 'Other program-defined condition or value (see details)';
    // ponytail: limited structural wording; extend SQL coverage here when a real manifest needs it.
    const expr = (n: SqlLogicNode, field?: string): string => {
      const children = n.children.map((child) => expr(child, field));
      if (n.kind === 'value' && fields[n.label]) return fieldTitle(n.label);
      if (n.label === 'auth.uid' && n.kind === 'function') return zh ? '目前使用者的識別碼' : 'Current user ID';
      if (n.label.startsWith('input.')) return zh ? '本次輸入值' : 'Input value';
      if (n.kind === 'expression' && children.length === 2) {
        const operators: Record<string, string> = zh ? { '<': '小於', '>': '大於', '<=': '小於或等於', '>=': '大於或等於', '=': '等於', '<>': '不等於' } : { '<': 'is less than', '>': 'is greater than', '<=': 'is at most', '>=': 'is at least', '=': 'equals', '<>': 'differs from' };
        if (operators[n.label]) { const right = expr(n.children[1]!, n.children[0]?.label); return children[0] === unknown || right === unknown ? unknown : `${children[0]} ${operators[n.label]} ${right}`; }
      }
      if (n.kind === 'predicate' && /^(AND|OR) ·/.test(n.label)) return `${zh ? n.label.startsWith('AND') ? '全部條件成立' : '至少一個條件成立' : n.label.startsWith('AND') ? 'All conditions' : 'Any condition'}：\n${children.join('\n')}`;
      if (n.label === 'Condition') return children.join('\n');
      if (n.kind === 'subquery' && n.label === 'EXISTS') return zh ? '存在符合條件的資料' : 'Matching data exists';
      if (n.kind === 'value' && n.label === 'NULL') return zh ? '空值' : 'Empty value';
      if (n.kind === 'value' && /^-?\d+(\.\d+)?$/.test(n.label)) {
        const value = Number(n.label);
        if (field && moneyMinorHint(fields[field]) && Number.isSafeInteger(value)) {
          const currencies = enumOptions(fields.currency);
          return formatMoneyMinor(value, currencies?.length === 1 ? currencies[0]!.value : undefined) || n.label;
        }
        return n.label;
      }
      if (n.kind === 'value' && /^'.*'$/.test(n.label)) {
        const value = n.label.slice(1, -1).replace(/''/g, "'");
        const options = (enumOptions(field ? fields[field] : undefined) ?? []).filter((o) => o.value === value && o.title);
        if (options.length === 1) return resolveLocalizedText(options[0]!.title!, language) || value;
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
    const rules: BusinessRule[] = [{ kind: 'operation', statement: statement.index, summary, title: `${operation} ${name || (zh ? '資料' : 'data')}`, body: [where?.children[0] ? expr(where.children[0]) : '', statement.mode === 'row' ? (zh ? '必須影響一筆；不符合時整批不寫入' : 'Exactly one affected row; otherwise the batch rolls back') : ''].filter(Boolean).join('\n') }];
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
      // ponytail: nested expressions stay in SQL details; don't project them as independent decisions.
      if (n.kind !== 'case' && n.kind !== 'subquery' && n.kind !== 'statement') n.children.forEach((child) => cases(child, n.kind === 'output' ? n.label : field));
    };
    outputs.forEach((output) => cases(output));
    return rules;
  });
}
