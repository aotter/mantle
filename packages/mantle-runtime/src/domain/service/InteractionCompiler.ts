import {
  MANTLE_REF_KEYWORD,
  RESERVED_ENTRY_COLUMNS,
  resolveMantleRef,
  type ProcedureManifest,
  type SchemaManifest,
  type ViewManifest,
} from "@aotter/mantle-spec";

/**
 * One way to act on an entry from a row (ADR-0029 §7). Compiled from what the
 * Manifest states or makes derivable; nothing is inferred from names.
 */
export interface RuntimeInteractionPlan {
  /** Procedure the interaction invokes. */
  readonly procedure: string;
  /** Schema whose entries the interaction is about. */
  readonly schema: string;
  /** Operation inputs taken from a row of `schema`: `input` ← row `field`. */
  readonly bind: readonly { readonly input: string; readonly field: string }[];
  /** Input that receives the row's observed `version`, when the operation locks it. */
  readonly version?: string;
  /** True when the Procedure mutates and locks the entry (its operation target). */
  readonly mutates: boolean;
  /** Declarative Views over `schema` whose rows expose every bound field
   *  (and `version` when bound). A View without `fields` returns only the
   *  reserved entry columns. SQL Views are never bound automatically. */
  readonly views: readonly string[];
}

const ID_OPS: ReadonlySet<string> = new Set(["update", "delete", "archive"]);
/** Builtin operations that compare the caller's `expectedVersion`; delete
 *  and archive lock the version they read themselves. */
const CALLER_VERSION_OPS: ReadonlySet<string> = new Set(["update", "upsert"]);

export function compileInteractions(
  procedures: readonly ProcedureManifest[],
  views: readonly ViewManifest[],
  schemas: readonly SchemaManifest[],
): readonly RuntimeInteractionPlan[] {
  const known = new Map(schemas.map((schema) => [schema.metadata.name, schema]));
  return procedures
    .flatMap((procedure) => interactionsOf(procedure, known))
    .map((interaction) => ({ ...interaction, views: sourceViews(interaction, views) }))
    .sort((a, b) => compareText(`${a.procedure}\0${a.schema}`, `${b.procedure}\0${b.schema}`));
}

type Draft = Omit<RuntimeInteractionPlan, "views">;

function interactionsOf(procedure: ProcedureManifest, known: ReadonlyMap<string, SchemaManifest>): Draft[] {
  const name = procedure.metadata.name;
  const input = procedure.spec.input;
  const properties = input.properties ?? {};
  const target = operationTarget(procedure);
  const out: Draft[] = [];
  if (target && known.has(target.schema)) {
    out.push({
      procedure: name,
      schema: target.schema,
      bind: [{ input: target.id, field: "id" }],
      ...(target.version ? { version: target.version } : {}),
      mutates: true,
    });
  }
  // A reference names what an input holds; it does not prove the Procedure
  // mutates that entry, so it binds the input only.
  for (const [input, property] of Object.entries(properties)) {
    const ref = resolveMantleRef(property);
    const schema = ref ? known.get(ref.schema) : undefined;
    if (!ref || !schema) continue;
    if (target && target.schema === ref.schema && target.id === input) continue;
    // During the ADR-0029 D8 transition a string-form ref that Admin still
    // infers onto another field has no agreed binding, so none is offered.
    if (typeof property[MANTLE_REF_KEYWORD] === "string" && legacyInferredField(input, schema) !== "id") continue;
    out.push({ procedure: name, schema: ref.schema, bind: [{ input, field: ref.field }], mutates: false });
  }
  return out;
}

/** Declared `spec.target`, or the target a builtin id operation implies. */
function operationTarget(procedure: ProcedureManifest): { schema: string; id: string; version?: string } | null {
  if (procedure.spec.target) return procedure.spec.target;
  const handler = procedure.spec.handler;
  if (handler.kind !== "builtin") return null;
  const properties = procedure.spec.input.properties ?? {};
  const idBased = ID_OPS.has(handler.op) || (handler.op === "upsert" && !handler.match && "id" in properties);
  if (!idBased || !("id" in properties)) return null;
  return {
    schema: handler.schema,
    id: "id",
    ...(CALLER_VERSION_OPS.has(handler.op) && "expectedVersion" in properties ? { version: "expectedVersion" } : {}),
  };
}

/** The field Admin's transitional string-form inference binds: a same-named
 *  target property, else the lone single-field unique index, else `id`. */
function legacyInferredField(input: string, schema: SchemaManifest): string {
  if (input in (schema.spec.schema.properties ?? {})) return input;
  const indexes = schema.spec.uniqueIndexes ?? [];
  return indexes.length === 1 && indexes[0]!.length === 1 ? indexes[0]![0]! : "id";
}

function sourceViews(interaction: Draft, views: readonly ViewManifest[]): string[] {
  const needed = [...interaction.bind.map(({ field }) => field), ...(interaction.version ? ["version"] : [])];
  return views
    .filter((view) => !view.spec.sql && view.spec.from === interaction.schema)
    .filter((view) => {
      const fields: readonly string[] = view.spec.fields ?? RESERVED_ENTRY_COLUMNS;
      return needed.every((field) => fields.includes(field));
    })
    .map((view) => view.metadata.name)
    .sort(compareText);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
