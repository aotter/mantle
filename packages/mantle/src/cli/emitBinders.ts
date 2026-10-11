/** Straight-line bind recipes for the built-in dialects; runtime registration owns their usability gate. */
import { parseNumeric, type JsonSchema, type RuntimePlan } from "../spec/domain/index.js";
import type { BindSpec } from "../core/sql/policy.js";

const quote = JSON.stringify;

/** Emits code only: no plan walk or encoder selection remains in the generated function. */
export function emitBinder(binds: readonly BindSpec[], dialect: "sqlite" | "postgres", helpers = new Set<string>(), page?: { readonly expressions: readonly string[] }): string {
  const call = (name: string, ...args: string[]) => { helpers.add(name); return `${name}(${args.join(", ")})`; };
  const encode = (type: string, value: string): string => {
    const num = parseNumeric(type);
    let encoded: string;
    if (num) {
      encoded = call("encodeNumeric", "value", String(num.p), String(num.s));
      if (dialect === "postgres") encoded = call("decodeNumeric", encoded, String(num.s));
    } else switch (type) {
      case "int4": case "int8": case "integer": encoded = call("encodeInteger", "value"); break;
      case "float8": case "real": encoded = "value"; break;
      case "bool": encoded = dialect === "postgres" ? "!!value" : "value ? 1 : 0"; break;
      case "text": encoded = "String(value)"; break;
      case "json": encoded = "JSON.stringify(value)"; break;
      case "geo":
        encoded = dialect === "postgres" ? "String(value)" : `dialect.codec.encode(${quote(type)}, value)`; break;
      case "timestamptz":
        encoded = call("encodeTimestamptz", "value");
        if (dialect === "postgres") encoded = call("decodeTimestamptz", encoded);
        break;
      case "date":
        encoded = call("encodeDate", "value");
        if (dialect === "postgres") encoded = call("decodeDate", encoded);
        break;
      default: encoded = `dialect.codec.encode(${quote(type)}, value)`;
    }
    return `(value = ${value}, value == null ? null : ${encoded})`;
  };
  const entries = binds.map((b) => {
    switch (b.k) {
      case "uid": return "ctx.uid";
      case "role": return "ctx.role ?? null";
      case "now": return encode("timestamptz", "ctx.now");
      case "cutoff": return encode("timestamptz", `ctx.now - ${quote(b.seconds)} * 1_000_000`);
      case "const": return quote(b.value) ?? "undefined";
      case "input": return encode(b.type, `input[${quote(b.name)}]`);
      case "version": return "extra.version";
      case "cursor": return `extra.cursor![${b.i}]`;
      case "dialect": return `dialect.bind(${quote(b)}, ctx)`;
    }
  });
  const parameter = page ? "{ cursor?: readonly unknown[]; pageSize: number; search?: string; eq?: readonly { value: unknown }[] }" : "{ version?: unknown; cursor?: readonly unknown[] } = {}";
  const locals = page?.expressions.map((expression, i) => `  const page${i} = ${expression};\n`).join("") ?? "";
  const values = [...entries, ...(page?.expressions.map((_, i) => `page${i}`) ?? [])];
  return `(ctx: BindContext, extra: ${parameter}, dialect: MantleDialect): unknown[] => {\n${locals}  const input = ctx.input ?? {};\n  let value: any;\n  return [${values.join(", ")}];\n}`;
}

/** sqlInput's declared own-property projection; case-folding never admits an undeclared input key. */
export function emitInputProjector(schema: JsonSchema | undefined): string {
  const fields = Object.keys(schema?.properties ?? {}).map((name) => `[${quote(name.toLowerCase())}]: Object.hasOwn(given, ${quote(name)}) ? given[${quote(name)}] : undefined`);
  return `(input: unknown): Record<string, unknown> => { const given = (input ?? {}) as Record<string, unknown>; return { ${fields.join(", ")} }; }`;
}

/** Fragments composed by the generated module emitter, alongside the exact-plan registration. */
export function emitBinders(plan: RuntimePlan): { imports: string[]; binders: string; projectors: string; pageBinders: string } | undefined {
  const lowered = plan.lowered;
  if (!lowered || !["@aotter/mantle/d1", "@aotter/mantle/postgres"].includes(lowered.dialect.name)) return undefined;
  const dialect = lowered.dialect.name === "@aotter/mantle/d1" ? "sqlite" : "postgres";
  const helpers = new Set<string>();
  const groups = (["view", "procedure"] as const).map((kind) => {
    const programs = kind === "view" ? lowered.views : lowered.procedures;
    return `${quote(kind)}: { ${Object.entries(programs).map(([name, modes]) => `[${quote(name)}]: { ${Object.entries(modes).map(([mode, statements]) => {
      const recipes = Array.isArray(statements) ? statements : [statements];
      return `${quote(mode)}: [${recipes.map((s) => emitBinder(s.binds, dialect, helpers)).join(", ")}]`;
    }).join(", ")} }`).join(", ")} }`;
  });
  const pageBinders = `{ ${Object.entries(lowered.views).map(([name, modes]) => `[${quote(name)}]: { ${Object.entries(modes).map(([mode, view]) => `${quote(mode)}: { ${Object.entries(view.paged).map(([shape, page]) => {
    const expressions = page.sources.map(source => "cursor" in source ? `extra.cursor![${source.cursor}]` : "search" in source ? "extra.search!" : "limit" in source ? "extra.pageSize + 1" : `extra.eq![${source.eq}]!.value`);
    return `[${quote(shape)}]: ${emitBinder(view.binds as readonly BindSpec[], dialect, helpers, { expressions })}`;
  }).join(", ")} }`).join(", ")} }`).join(", ")} }`;
  const projectors = (["view", "procedure"] as const).map((kind) => {
    const programs = kind === "view" ? plan.views : plan.procedures;
    return `${quote(kind)}: { ${Object.entries(programs).filter(([, p]) => kind === "view" || ("handler" in p && "sql" in p.handler)).map(([name, p]) => `[${quote(name)}]: ${emitInputProjector(p.input)}`).join(", ")} }`;
  });
  return {
    imports: helpers.size ? [`import { ${[...helpers].sort().join(", ")} } from "@aotter/mantle/${dialect === "sqlite" ? "d1" : "postgres"}";`] : [],
    binders: `{ ${groups.join(", ")} }`, projectors: `{ ${projectors.join(", ")} }`, pageBinders,
  };
}
