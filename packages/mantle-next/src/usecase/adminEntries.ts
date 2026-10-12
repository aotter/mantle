/** Generate selected Admin adapters and concrete validators; bare Store rows remain native. */
import { collectionOf } from "@aotter/mantle/compiler";
import { notNullColumns, resolveMantleRef, type JsonSchema } from "@aotter/mantle/compiler";
import type { GenerateInput } from "../domain/model.js";
import { databaseImport, q, isSqlite } from "../domain/entry.js";
import { declaredType } from "../domain/columns.js";
import { emitValidation } from "./validation.js";
import { dialect as sqlite } from "../kernel/dialect/sqlite.js";
import { dialect as postgres } from "../kernel/dialect/postgres.js";
export function emitAdminEntries({ plan, target }: GenerateInput): Record<string, string> {
    if (!Object.keys(plan.schemas).length) return {};
    const all = Object.values(plan.schemas), sqliteTarget = isSqlite(target), d = sqliteTarget ? sqlite : postgres, files: Record<string, string> = {}, imports: string[] = [], descriptors: string[] = [], indexes: string[] = [];
    const refs = Object.values(plan.procedures).some(p => "ref" in p.handler), parents = all.filter(s => all.some(c => c.translates?.parent.toLowerCase() === s.name));
    let hasWire = false;
    for (const [i, s] of all.entries()) {
        const descriptor = collectionOf(s, all), props = s.schema.properties ?? {}, scope = s.scope && (s.names[s.scope] ?? s.scope), fields = Object.fromEntries([...Object.keys(s.fields).map(column => [s.names[column] ?? column, column]), ["id", "id"], ["version", "version"], ["createdAt", "created_at"], ["updatedAt", "updated_at"], ["authorId", "author_id"], ...(s.publishing ? [["status", "status"]] : [])]);
        const writable = Object.fromEntries(Object.entries(props).filter(([name]) => name !== scope).map(([name, property]) => [name, (s.schema.required ?? []).includes(name) ? property : { ...property, nullable: true }]));
        const root: JsonSchema = { ...s.schema, properties: writable, required: (s.schema.required ?? []).filter(name => name !== scope), additionalProperties: false };
        const geo = Object.entries(writable).filter(([, property]) => property.format === "geo").map(([name]) => name);
        const partial = { ...root, properties: Object.fromEntries(Object.entries(writable).filter(([name]) => !geo.includes(name))), required: [] };
        for (const [kind, input] of [["full", root], ["partial", partial]] as const) {
            const problems: string[] = [], generated = emitValidation({ views: {}, procedures: { [s.name]: { input } } }, (_path, message) => problems.push(message));
            let source = generated[`validation/procedures/${encodeURIComponent(s.name)}.ts`]!;
            const error = (message: string) => `throw new ContractError("ADMIN_VALIDATION_UNAVAILABLE",${q(message)},${q(`admin/entries/${s.name}/data`)},{status:501});`;
            if (problems.length)
                source = `import {ContractError} from "@aotter/mantle-next/contracts";\nexport function validate(_raw:unknown):Record<string,unknown>{${error([...new Set(problems)].join(" "))}}\n`;
            else if (kind === "partial" && geo.length)
                source = `import {ContractError} from "@aotter/mantle-next/contracts";\n` + source.replace("export function validate(raw:unknown):Record<string,unknown> { ", `export function validate(raw:unknown):Record<string,unknown> { if(raw&&typeof raw==="object")for(const field of ${q(geo)})if(Object.hasOwn(raw,field)){${error("Admin Geo writes are unavailable; use declared Procedures.")}} `);
            files[`validation/admin/${encodeURIComponent(s.name)}/${kind}.ts`] = source.replaceAll(`procedures/${s.name}/input`, `admin/entries/${s.name}/data`);
            imports.push(`import {validate as ${kind}${i}} from "./validation/admin/${encodeURIComponent(s.name)}/${kind}.js";`);
        }
        const list = descriptor.list, preview = [...new Set([...(list.primaryField ? [list.primaryField] : []), ...list.columns])], titles = [...new Set([list.primaryField, "title", "name", "slug", ...(s.schema.required ?? []).filter(name => [props[name]?.type].flat().includes("string"))].filter((name): name is string => !!name))];
        const related = all.flatMap(child => child.translates?.parent.toLowerCase() === s.name ? [{ collection: child.name, kind: "translation", parentField: child.names[child.translates.on.toLowerCase()] ?? child.translates.on, childField: child.names[child.translates.on.toLowerCase()] ?? child.translates.on }] : child === s ? [] : Object.entries(child.schema.properties ?? {}).flatMap(([field, property]) => { const ref = resolveMantleRef(property); return ref?.schema.toLowerCase() === s.name ? [{ collection: child.name, kind: "field", parentField: s.names[ref.field.toLowerCase()] ?? ref.field, childField: field }] : []; }));
        if (s.translates)
            related.unshift({ collection: s.name, kind: "translation", parentField: s.names[s.translates.on.toLowerCase()] ?? s.translates.on, childField: s.names[s.translates.on.toLowerCase()] ?? s.translates.on });
        const sortable: Record<string, string> = { id: "id", updatedAt: "updated_at", updated_at: "updated_at", ...(s.publishing ? { status: "status" } : {}) };
        // An index's first varying column follows the bound scope column. Draft fields may be nullable: Store pages NULLS LAST.
        for (const index of [...s.indexes ?? [], ...s.unique ?? []]) {
            const field = index[0] === s.scope ? index[1] : index[0];
            if (field && (notNullColumns(s).has(field) || s.publishing && (s.schema.required ?? []).includes(s.names[field] ?? field)))
                sortable[s.names[field] ?? field] = field;
        }
        const type = (column: string) => declaredType(s.fields, column) ?? "text";
        const inherited = s.translates ? plan.schemas[s.translates.parent.toLowerCase()] : undefined;
        const readFields = { ...inherited?.fields, ...s.fields }, readNames = { ...inherited?.names, ...s.names };
        const output = sqliteTarget ? Object.entries(readFields).filter(([column]) => column !== s.scope).flatMap(([column, native]) => native === "json" || native === "bool" ? [[column, native]] : []) : [];
        hasWire ||= !!output.length;
        const filters = Object.keys(fields).map(name => `[${q(name)},(raw:string)=>coerce(raw,${q([props[name]?.type].flat().find(t => t && t !== "null") ?? (name === "version" ? "integer" : "string"))},${q(name)},${q(props[name]?.format ?? (["createdAt", "updatedAt"].includes(name) ? "date-time" : ""))})]`);
        const cursorCases = Object.values(sortable).map(column => {
            const native = type(column), nullable = column !== "id" && column !== "updated_at" && column !== "status" && !notNullColumns(s).has(column);
            const scalar = native === "timestamptz" ? 'typeof value==="string"&&validTime(value)' : native === "date" ? 'typeof value==="string"&&validDate(value)' : native === "bool" ? (sqliteTarget ? 'value===0||value===1' : 'typeof value==="boolean"') : ["integer", "int4", "int8"].includes(native) ? `validInteger(value,${native === "int4" ? "-2147483648n,2147483647n" : "-9223372036854775808n,9223372036854775807n"})` : ["real", "float8"].includes(native) ? 'typeof value==="number"&&Number.isFinite(value)' : 'typeof value==="string"';
            return `[${q(column)},(value:unknown)=>${nullable ? 'value===null||' : ''}(${scalar})]`;
        });
        const nullableSorts = [...new Set(Object.values(sortable).filter(column => column !== "id" && column !== "updated_at" && column !== "status" && !notNullColumns(s).has(column)))];
        const defaults = Object.fromEntries(Object.entries(writable).filter(([, property]) => Object.hasOwn(property, "default")).map(([name, property]) => [name, property.default]));
        imports.push(`const fields${i}=Object.fromEntries(${q(Object.entries(fields))});`);
        imports.push(`const cursorChecks${i}:Record<string,(value:unknown)=>boolean>=Object.fromEntries([${cursorCases.join(",")}]);`);
        const nativeDates = Object.entries(props).filter(([name]) => s.fields[fields[name]!] === "date").map(([name]) => name);
        descriptors.push(`{${sqliteTarget ? "" : `native:value=>{nativeText(value);if(value&&typeof value===\"object\")for(const field of ${q(nativeDates)}){const date=(value as Record<string,unknown>)[field];if(typeof date===\"string\"&&date.startsWith(\"0000-\"))throw new ContractError(\"INPUT_VALIDATION_FAILED\",\"PostgreSQL dates have no year zero.\",${q(`admin/entries/${s.name}/data/`)}+field);}},`}name:${q(s.name)},descriptor:allCollections[${q(s.name)}],publishing:${!!s.publishing},readOnly:${s.schema.readOnly === true},fields:fields${i},filters:Object.fromEntries([${filters.join(",")}]),sortable:Object.fromEntries(${q(Object.entries(sortable))}),${sqliteTarget ? 'idOrder:"asc",' : ""}nulls:(column,ascending)=>(${q(nullableSorts)} as readonly string[]).includes(column)?${sqliteTarget ? 'ascending?"first":"last"' : 'ascending?"last":"first"'}:undefined,cursor:(column,value)=>cursorChecks${i}[column]!(value),preview:${q(preview)},titles:${q(titles)},csv:${q(["id", ...(s.publishing ? ["status"] : []), "version", "updated_at", ...Object.keys(props).filter(name => name !== scope && s.fields[fields[name]!] !== "geo")])},defaults:Object.fromEntries(${q(Object.entries(defaults))}),${descriptor.parent ? `parent:${q(descriptor.parent)},` : ""}related:${q(related)},validate:(data,full)=>full?full${i}(data):partial${i}(data),values:data=>Object.fromEntries(Object.entries(data).map(([name,value])=>[fields${i}[name],${sqliteTarget ? `([${Object.entries(s.fields).filter(([, t]) => t === "bool").map(([c]) => q(s.names[c] ?? c)).join(",")}] as readonly string[]).includes(name)&&value!=null?Number(value):value` : "value"}])),row:raw=>rename(${output.length ? `wireRows([raw],${q(output)})[0]!` : "raw"},Object.fromEntries(${q(Object.entries(readNames).filter(([name]) => name !== s.scope))}))}`);
        indexes.push(`CREATE INDEX IF NOT EXISTS ${d.ident(`_mantle_admin_${s.name}_updated`)} ON ${d.ident(s.name)} (${[...(s.scope ? [s.scope] : []), "updated_at", "id"].map(d.ident).join(", ")});`);
    }
    files["admin-entries.ts"] = `import { entries,type EntrySchema,type EntriesStore } from "@aotter/mantle-next/admin-entries";
import {ContractError${hasWire ? ",wireRows" : ""},type Caller} from "@aotter/mantle-next/contracts";
import {store${refs ? ",type Handlers" : ""}} from "./generated.js";
import {encodeDate,encodeTimestamptz} from "@aotter/mantle-next/scalars";
import {allCollections} from "./admin-descriptors.js";
${databaseImport(target)}
${parents.length ? 'import {translationLocales} from "./translations.js";' : ""}
${imports.join("\n")}
const validInteger=(value:unknown,min:bigint,max:bigint)=>{if(typeof value==="number"){if(!Number.isSafeInteger(value))return false;}else{if(typeof value!=="string"||value.length>20||!/^(?:0|-?[1-9]\\d*)$/.test(value))return false;}const number=BigInt(value as string|number);return number>=min&&number<=max;};
const validTime=(value:string)=>{try{encodeTimestamptz(value);return true;}catch{return false;}};
const validDate=(value:string)=>{${sqliteTarget ? "" : 'if(value.startsWith("0000-"))return false;'}try{encodeDate(value);return true;}catch{return false;}};
${sqliteTarget ? "" : `const nativeText=(value:unknown)=>{const pending=[value];while(pending.length){const next=pending.pop();if(typeof next==="string"){if(next.includes("\\0"))throw new ContractError("INPUT_VALIDATION_FAILED","PostgreSQL text and JSON cannot contain NUL.","admin/entries");}else if(next&&typeof next==="object"){for(const [key,child] of Object.entries(next))pending.push(key,child);}}};`}
const rename=(row:Record<string,unknown>,names:Record<string,string>)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[Object.hasOwn(names,key)?names[key]!:key,value]));
const coerce=(raw:string,type:string,field:string,format=""):unknown=>{${sqliteTarget ? "" : "nativeText(raw);"}if(format==="date"||format==="date-time"){try{${sqliteTarget ? "" : 'if(format==="date"&&!validDate(raw))throw Error();'}(format==="date"?encodeDate:encodeTimestamptz)(raw);return raw;}catch{throw new ContractError("INPUT_VALIDATION_FAILED","Invalid date filter.","admin/entries/"+field);}}if(type==="boolean"){if(raw==="true"||raw==="false")return ${sqliteTarget ? "Number(raw===\"true\")" : "raw===\"true\""};}else if(type==="number"||type==="integer"){const value=Number(raw);if(raw.trim()&&Number.isFinite(value)&&(type!=="integer"||Number.isSafeInteger(value)))return value;}else return raw;throw new ContractError("INPUT_VALIDATION_FAILED","Invalid filter value.","admin/entries/"+field);};
const schemas=[${descriptors.join(",\n")}] satisfies readonly EntrySchema[];
export function adminEntries<Env>(${refs ? "options:{handlers:Handlers}" : ""}) {return entries<Env,Database>(schemas,(db,caller)=>store(db,caller${refs ? ",options" : ""}) as unknown as EntriesStore${parents.length ? `,(db,caller,name,rows)=>${parents.map(s => `name===${q(s.name)}?translationLocales(db,caller,${q(s.name)},rows as never)`).join(":")}:Promise.resolve({})` : ""});}
`;
    files["admin-schema.sql"] = indexes.join("\n") + "\n";
    return files;
}
