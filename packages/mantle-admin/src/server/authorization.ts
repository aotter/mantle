/** Request-only filtering of generated Admin metadata. */
import { authorized } from "@aotter/mantle/authorization";
import type { Authorize, Caller, Target } from "@aotter/mantle/contracts";
import type { Metadata, View, Operation } from "./index.js";

type Item = Record<string, unknown>;
type Section = Record<string, unknown> & Record<string, readonly Item[]>;
export async function visibleMetadata<Database, Handlers>(metadata: Metadata, catalogue: Item, views: readonly View<Database>[], operations: readonly Operation<Database, Handlers>[], previews: readonly View<Database>[], authorize: Authorize, caller: Caller): Promise<Metadata> {
    const filter = async <T>(items: readonly T[], allows: (item: T) => boolean | Promise<boolean>): Promise<T[]> => {
        const permitted = await Promise.all(items.map(allows));
        return items.filter((_, i) => permitted[i]);
    };
    const permits = (target: Target) => authorized(authorize, target, caller);
    const sees = (kind: "view" | "procedure", routes: readonly {name: string; allows: (caller: Caller) => boolean}[], name: string) => {
        const route = routes.find(route => route.name === name);
        return (route ? route.allows(caller) : metadata.allows?.({kind,name}, caller) === true) && permits({kind,name});
    };
    const collections = await filter(metadata.collections, item => permits({kind:"schema",name:item.name,action:"read"}));
    const allCollections = Object.fromEntries((await filter(Object.values(metadata.allCollections ?? Object.fromEntries(metadata.collections.map(c => [c.name, c]))), item => permits({kind:"schema",name:item.name,action:"read"}))).map(item => [item.name,item]));
    const visibleViews = await filter(metadata.views, item => sees("view", views, item.name));
    const visibleOperations = await filter(metadata.operations, item => sees("procedure", operations, item.name));
    const tools = await filter((catalogue.tools ?? []) as readonly Item[], tool => {
        const target = ((metadata.webmcp as {tools?: readonly Item[]}).tools?.find(item => item.name === tool.name)?.target) as Target | undefined;
        return target ? target.kind === "view" ? sees("view", views, target.name) : sees("procedure", operations, target.name) : false;
    });
    const toolNames = new Set(tools.map(tool => tool.name));
    const webmcp = {...catalogue, tools, routes: Object.fromEntries(Object.entries((catalogue.routes ?? {}) as Item).filter(([name]) => toolNames.has(name)))};
    let developerConsole = metadata.developerConsole;
    if (developerConsole) {
        const d = developerConsole as Record<string, Section>;
        const schemas = await filter(d.dataModel?.schemas ?? [], item => permits({kind:"schema",name:String(item.name),action:"read"}));
        const devViews = await filter(d.dataModel?.views ?? [], item => sees("view", previews, String(item.name)));
        const procedures = await filter(d.logic?.procedures ?? [], item => sees("procedure", operations, String(item.name)));
        const names = new Set(procedures.map(item => item.name));
        const triggers = (d.logic?.triggers ?? []).filter(item => names.has(item.target));
        const atoms = new Set([...schemas.map(item => "Schema:" + item.name), ...devViews.map(item => "View:" + item.name), ...procedures.map(item => "Procedure:" + item.name), ...triggers.map(item => "Trigger:" + item.name)]);
        const callable = (item: Item) => item.kind === "view" ? sees("view", previews, String(item.target)) : sees("procedure", operations, String(item.target));
        developerConsole = {
            ...d,
            dataModel: {...d.dataModel, schemas, views: devViews},
            logic: {...d.logic, procedures, triggers},
            interfaces: {...d.interfaces, http: await filter(d.interfaces?.http ?? [], callable), callable: await filter(d.interfaces?.callable ?? [], callable)},
            graph: {...d.graph, atoms: (d.graph?.atoms ?? []).filter(item => atoms.has(String(item.id))), relations: (d.graph?.relations ?? []).filter(item => atoms.has(String(item.sourceId)) && atoms.has(String(item.targetId)))},
            operations: {...d.operations, schedules: (d.operations?.schedules ?? []).filter(item => names.has(item.procedure)), ttlPolicies: (d.operations?.ttlPolicies ?? []).filter(item => atoms.has("Schema:" + item.schema))},
        };
    }
    return {...metadata, collections, allCollections, views: visibleViews, operations: visibleOperations, webmcp, developerConsole};
}
