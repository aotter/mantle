/** The same assertions execute against every actual native handle, including local D1. */
export const source = `apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: records}
spec:
 title: Fixture
 lifecycle: operational
 scope: {owner: auth.uid()}
 indexes: [[owner, displayTitle], [owner, score]]
 searchableFields: [displayTitle]
 ttl: {field: expiresAt, expireAfterSeconds: 0}
 uiSchema: {list: {primaryField: displayTitle, columns: [score, active, document]}}
 schema:
  type: object
  required: [owner, displayTitle, score]
  properties:
   owner: {type: string}
   displayTitle: {type: string, minLength: 2}
   score: {type: integer, minimum: 1, default: 7}
   label: {type: string}
   expiresAt: {type: string, format: date-time}
   active: {type: boolean, default: false}
   document: {type: object, properties: {label: {type: string}}, additionalProperties: false}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: articles}
spec:
 title: Fixture
 lifecycle: publishing
 scope: {owner: auth.uid()}
 uniqueIndexes: [[owner, slug]]
 indexes: [[owner, title]]
 schema: {type: object, required: [owner, title, slug], properties: {owner: {type: string}, title: {type: string, minLength: 2}, slug: {type: string}, active: {type: boolean}, content: {type: object, properties: {text: {type: string}}}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: translations}
spec:
 title: Fixture
 lifecycle: publishing
 localized: true
 translates: {parent: articles, on: slug}
 scope: {owner: auth.uid()}
 indexes: [[owner, slug]]
 schema: {type: object, required: [owner, slug, locale, title], properties: {owner: {type: string}, slug: {type: string}, locale: {type: string}, title: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: children}
spec:
 title: Fixture
 lifecycle: operational
 indexes: [[owner, id]]
 scope: {owner: auth.uid()}
 schema: {type: object, required: [owner, parentId, label], properties: {owner: {type: string}, parentId: {type: string, x-mantle-ref: articles}, label: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: immutable}
spec:
 title: Fixture
 lifecycle: operational
 schema: {type: object, readOnly: true, required: [label], properties: {label: {type: string}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: locations}
spec:
 title: Fixture
 lifecycle: operational
 schema: {type: object, required: [label], properties: {label: {type: string}, place: {type: string, format: geo}}}
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: {name: scalars}
spec:
 title: Fixture
 lifecycle: operational
 scope: {owner: auth.uid()}
 indexes: [[owner, label], [owner, day], [owner, stamp]]
 schema: {type: object, required: [owner,label,day,stamp], properties: {owner: {type: string}, label: {type: string}, day: {type: string, format: date}, stamp: {type: string, format: date-time}, document: {type: object, properties: {leaf: {type: string}}, additionalProperties: true}}}
`;
export const staff = { kind: "user", subject: "staff-a", role: "staff", scopes: [], credential: "session", credentialId: null, clientId: null } as const;
const check = (ok: unknown, message: string) => {
    if (!ok)
        throw Error(message);
};
export async function exerciseEntries(fetch: (request: Request, env: object) => Promise<Response | undefined>, sql: (text: string, values?: unknown[]) => Promise<Record<string, any>[]>, queries: () => number, sqlite: boolean) {
    const response = (path: string, method = "GET", data?: unknown) => fetch(new Request("https://app.test/admin/api" + path, { method, headers: { origin: "https://app.test", "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), {});
    const json = async (path: string, method = "GET", data?: unknown) => { const r = (await response(path, method, data))!; const body = await r.json() as any; check(r.status === 200, `${method} ${path} ${r.status}: ${JSON.stringify(body)}`); return body; };
    const scalar = { label: "safe", day: "2026-10-12", stamp: "2026-10-12T00:00:00Z" };
    const scalarEntry = await json("/entries", "POST", { collection: "scalars", data: scalar });
    for (const suffix of ["&sort=label&cursor=" + encodeURIComponent(JSON.stringify(["a\0b", "x"])), "&sort=label&cursor=" + encodeURIComponent(JSON.stringify(["safe", "a\0b"])), "&filter_field=label&filter_value=a%00b", "&sort=day&cursor=" + encodeURIComponent(JSON.stringify(["0000-01-01", "x"])), "&filter_field=day&filter_value=0000-01-01"]) {
        const count = queries(), r = (await response("/entries?collection=scalars" + suffix))!;
        check(r.status === (sqlite ? 200 : 400) && queries() - count === (sqlite ? 1 : 0), "dialect-native cursor/filter constraints");
    }
    {
        const count = queries(), r = (await response("/entries/a%00b?collection=scalars"))!;
        check(r.status === 400 && queries() === count, "shared Admin malformed-path guard refuses NUL before SQL");
    }
    for (const data of [{ ...scalar, label: "a\0b" }, { ...scalar, day: "0000-01-01" }, { ...scalar, document: { leaf: "a\0b" } }, { ...scalar, document: { unknown: { deeper: "a\0b" } } }, { ...scalar, document: { ["a\0b"]: "safe" } }]) {
        const count = queries(), r = (await response("/entries", "POST", { collection: "scalars", data }))!;
        check(r.status === (sqlite ? 200 : 400) && (sqlite ? queries() - count >= 1 && queries() - count <= 2 : queries() === count), "dialect-native TEXT/DATE/JSON write guard");
    }
    const escaped = await json("/entries", "POST", { collection: "scalars", data: { ...scalar, label: "literal \\u0000", document: { leaf: "literal \\u0000", ["literal \\u0000"]: "safe" } } });
    check(escaped.entry.data.document.leaf === "literal \\u0000", "literal backslash-u0000 is preserved");
    if (!sqlite) {
        for (const data of [{ label: "a\0b" }, { day: "0000-01-01" }, { document: { unknown: { deeper: "a\0b" } } }]) {
            const count = queries(), r = (await response("/entries/" + scalarEntry.entry.id + "?collection=scalars", "PATCH", { expectedVersion: 1, data }))!;
            check(r.status === 400 && queries() === count, "PG patch native guard before policy read");
        }
    }
    // Unsupported Geo validation affects selected Admin writes only; native reads and safe patches remain available.
    let geoBefore = queries();
    const geoCreate = (await response("/entries", "POST", { collection: "locations", data: { label: "Unavailable" } }))!;
    const geoError = await geoCreate.json() as any;
    check(geoCreate.status === 501 && geoError.error.code === "ADMIN_VALIDATION_UNAVAILABLE" && queries() === geoBefore, "unsupported Admin write: explicit 501 and zero SQL");
    await sql(`INSERT INTO locations(id,version,created_at,updated_at,label,place_lat,place_lng) VALUES ('place',1,${sqlite ? "0,0" : "now(),now()"},'Before',25,121)`);
    const patchedGeo = await json("/entries/place?collection=locations", "PATCH", { expectedVersion: 1, data: { label: "After" } });
    check(patchedGeo.entry.version === 2, "safe non-geo patch");
    const coords = await sql("SELECT place_lat,place_lng FROM locations WHERE id='place'");
    check(Number(coords[0]!.place_lat) === 25 && Number(coords[0]!.place_lng) === 121, "Geo coordinates preserved");
    geoBefore = queries();
    const geoPatch = (await response("/entries/place?collection=locations", "PATCH", { expectedVersion: 2, data: { place: "25,121" } }))!;
    check(geoPatch.status === 501 && queries() - geoBefore === 1, "Geo patch only reads current row, no write");
    for (const data of [{ displayTitle: "One", label: "present", active: true, document: { label: "doc" } }, { displayTitle: "=formula" }])
        await json("/entries", "POST", { collection: "records", data });
    let page = await json("/entries?collection=records");
    check(page.items.length === 2, "list rows");
    check(page.items[0].data_preview.score === 7, "defaults");
    check(typeof page.items[0].updated_at === "number", "timestamp milliseconds");
    // A foreign and an expired native row are invisible to every entry read/search path.
    const times = sqlite ? "0,0" : "now(),now()";
    await sql(`INSERT INTO records(id,version,created_at,updated_at,owner,displaytitle,score) VALUES ('foreign',1,${times},'staff-b','Foreign',7)`);
    await sql(`INSERT INTO records(id,version,created_at,updated_at,owner,displaytitle,score,expiresat) VALUES ('expired',1,${times},'staff-a','Expired',7,${sqlite ? "0" : "'2000-01-01'"})`);
    for (const hidden of ["foreign", "expired"]) {
        check((await response("/entries/" + hidden + "?collection=records"))!.status === 404, "hidden editor");
        check((await json("/entries?collection=records&search=" + hidden)).items.length === 0, "hidden id search");
        check((await response("/entries/" + hidden + "?collection=records", "DELETE"))!.status === 404, "hidden delete");
    }
    const first = page.items.find((item: any) => item.data_preview.displayTitle === "One"), id = first.id;
    const editor = await json("/entries/" + id + "?collection=records");
    check(editor.entry.data.active === true && editor.entry.data.document.label === "doc", "bool and JSON wire");
    check(!("owner" in editor.entry.data), "scope is not exposed");
    let before = queries();
    check((await response("/entries?collection=records&search=%00"))!.status === 400 && queries() === before, "NUL refused before read");
    before = queries();
    await json("/entries?collection=records&sort=score&cursor=" + encodeURIComponent(JSON.stringify([sqlite ? 7 : "7", "x"])));
    check(queries() - before === 1, "native integer cursor accepted with one SQL read");
    for (const key of ["9".repeat(40), "9223372036854775808", "-9223372036854775809", "00", "-0", Number.MAX_SAFE_INTEGER + 1]) {
        before = queries();
        const cursor = encodeURIComponent(JSON.stringify([key, "x"]));
        check((await response("/entries?collection=records&sort=score&cursor=" + cursor))!.status === 400 && queries() === before, "integer cursor range before SQL");
    }
    for (const suffix of ["&limit=0", "&limit=501", "&sort=unknown", "&scope_field=owner", "&filter_field=__proto__&filter_value=x", "&filter_field=score&filter_value=no", "&cursor=" + encodeURIComponent(JSON.stringify([{}, id]))]) {
        before = queries();
        check((await response("/entries?collection=records" + suffix))!.status === 400 && queries() === before, "invalid query before SQL");
    }
    before = queries();
    page = await json("/entries?collection=records&filter_field=score&filter_value=7&scope_field=score&scope_value=8");
    check(page.items.length === 0 && queries() === before, "contradictory equalities no read");
    before = queries();
    page = await json("/entries?collection=records&limit=1");
    check(page.items.length === 1 && page.next_cursor && queries() - before === 1, "one native list read");
    const next = await json("/entries?collection=records&limit=1&cursor=" + encodeURIComponent(page.next_cursor));
    check(next.items.length === 1 && next.items[0].id !== page.items[0].id, "keyset tie");
    check((await json("/bootstrap?collection=records")).entries.items.length === 2, "bootstrap first page");
    before = queries();
    check((await response("/entries?collection=records&filter_field=expiresAt&filter_value=2000-02-30T00%3A00%3A00Z"))!.status === 400 && queries() === before, "date filter fails before SQL");
    const denied = await fetch(new Request("https://app.test/admin/api/entries", { method: "POST", headers: { origin: "https://evil.test" }, body: JSON.stringify({ collection: "records", data: { displayTitle: "Blocked" } }) }), {});
    check(denied!.status === 403, "cookie origin boundary");
    const changed = await json("/entries/" + id + "?collection=records", "PATCH", { expectedVersion: 1, data: { label: null } });
    check(changed.entry.version === 2 && changed.entry.data.label === null, "optional clear");
    check((await response("/entries/" + id + "?collection=records", "PATCH", { expectedVersion: 999, data: {} }))!.status === 200, "legacy stale empty patch remains a no-op");
    check((await response("/entries/" + id + "?collection=records", "PATCH", { expectedVersion: 1, data: { displayTitle: "stale" } }))!.status === 409, "OCC conflict");
    for (const data of [{ id: "chosen" }, { owner: "other" }, { displayTitle: "x" }, { document: { extra: true } }])
        check((await response("/entries", "POST", { collection: "records", data }))!.status === 400, "native or invalid values refused");
    check((await response("/entries", "POST", { collection: "immutable", data: { label: "no" } }))!.status === 409, "readOnly create");
    const draft = await json("/entries", "POST", { collection: "articles", data: { slug: "parent" } }), parent = draft.entry.id;
    check(draft.entry.status === "draft" && draft.entry.version === 1, "partial draft");
    check((await response("/entries/" + parent + "/publish?collection=articles", "POST"))!.status === 400, "full publish validation");
    await json("/entries/" + parent + "?collection=articles", "PATCH", { expectedVersion: 1, data: { title: "Parent" } });
    await json("/entries/" + parent + "/publish?collection=articles", "POST");
    check((await response("/entries/" + parent + "?collection=articles", "PATCH", { expectedVersion: 3, data: { title: "protected" } }))!.status === 409, "published edit protected");
    check((await response("/entries/" + parent + "?collection=articles", "DELETE"))!.status === 409, "published deletion protected");
    const translation = await json("/entries", "POST", { collection: "translations", data: { slug: "parent", locale: "fr", title: "Parent FR" } });
    await json("/entries/" + translation.entry.id + "/publish?collection=translations", "POST");
    page = await json("/entries?collection=articles");
    check(page.items[0].translation_locales.includes("fr"), "translation locales");
    await json("/entries", "POST", { collection: "children", data: { parentId: parent, label: "child" } });
    const related = await json("/entries/" + parent + "?collection=articles");
    check(related.related.some((r: any) => r.relationship.kind === "field" && r.entries.length === 1) && related.related.some((r: any) => r.relationship.kind === "translation" && r.entries.length === 1), "related sections");
    const restore = await json("/entries/" + parent + "/unpublish?collection=articles", "POST");
    await sql(`UPDATE articles SET status='archived',version=version+1 WHERE id=${sqlite ? "?" : "$1"}`, [parent]);
    const fromArchive = await json("/entries/" + parent + "/unpublish?collection=articles", "POST");
    check(fromArchive.entry.status === "draft" && fromArchive.entry.version === restore.entry.version + 2, "archived unpublish restores draft with OCC bump");
    const orphan = await json("/entries", "POST", { collection: "translations", data: { slug: "parent", locale: "ja", title: "Parent JA" } });
    check((await response("/entries/" + orphan.entry.id + "/publish?collection=translations", "POST"))!.status === 409, "translation parent publish guard");
    // Bulk UI calls are independent: one stale action cannot undo an earlier successful action.
    const batch = await json("/entries", "POST", { collection: "records", data: { displayTitle: "Bulk" } });
    await json("/entries/" + batch.entry.id + "?collection=records", "PATCH", { expectedVersion: 1, data: { displayTitle: "Bulk OK" } });
    check((await response("/entries/" + batch.entry.id + "?collection=records", "PATCH", { expectedVersion: 1, data: { displayTitle: "stale" } }))!.status === 409, "bulk individual failure");
    check((await json("/entries/" + batch.entry.id + "?collection=records")).entry.data.displayTitle === "Bulk OK", "bulk success retained");
    const csv = (await response("/entries/export?collection=records"))!;
    check(csv.status === 200 && (await csv.text()).includes("'=formula"), "CSV formula guard");
    // Whole nullable order matches each native engine's independent SQL, including NULL and equal-value ties.
    for (let i = 0; i < 7; i++)
        await json("/entries", "POST", { collection: "articles", data: { slug: "sort-" + i, ...(i % 3 ? { title: "Tie" } : {}) } });
    for (const direction of ["asc", "desc"]) {
        const oracle = await sql(`SELECT id FROM articles WHERE owner=${sqlite ? "?" : "$1"} ORDER BY title ${direction},id ${sqlite ? "asc" : direction}`, [staff.subject]), ids: string[] = [];
        let cursor: string | null = null;
        do {
            const page = await json("/entries?collection=articles&sort=title&direction=" + direction + "&limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
            ids.push(...page.items.map((row: any) => row.id));
            cursor = page.next_cursor;
        } while (cursor);
        check(JSON.stringify(ids) === JSON.stringify(oracle.map(row => row.id)), "nullable order complete " + direction);
    }
    await json("/entries/" + id + "?collection=records", "DELETE");
    check((await response("/entries/" + id + "?collection=records"))!.status === 404, "delete committed");
    return { ok: true };
}
/** All direction/null/tie combinations match an independent native SQL oracle, one read per page. */
export async function exerciseNullableOrder(table: any, sql: (text: string, values?: unknown[]) => Promise<Record<string, any>[]>, queries: () => number, sqlite: boolean) {
    for (const order of ["asc", "desc"] as const)
        for (const nulls of ["first", "last"] as const)
            for (const idOrder of ["asc", "desc"] as const) {
                const expected = await sql(`SELECT id FROM articles WHERE owner=${sqlite ? "?" : "$1"} ORDER BY title ${order} NULLS ${nulls},id ${idOrder}`, [staff.subject]), ids: string[] = [];
                let cursor: string | undefined;
                do {
                    const before = queries(), page = await table.find({ orderBy: "title", order, nulls, idOrder, limit: 1, cursor });
                    check(queries() - before === 1, "nullable page uses one query");
                    ids.push(...page.rows.map((row: {
                        id: string;
                    }) => row.id));
                    cursor = page.cursor ?? undefined;
                } while (cursor);
                check(JSON.stringify(ids) === JSON.stringify(expected.map(row => row.id)), "nullable keyset equals native SQL oracle");
            }
}
export async function exerciseEntryRace(fetch: (request: Request, env: object) => Promise<Response | undefined>, sql: (text: string, values?: unknown[]) => Promise<Record<string, any>[]>, arm: (hook: () => Promise<unknown>) => void, sqlite: boolean) {
    const response = async (path: string, method: string, data: unknown) => (await fetch(new Request("https://app.test/admin/api" + path, { method, headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(data) }), {}))!;
    const created = await response("/entries", "POST", { collection: "articles", data: { title: "Before race", slug: "race" } }), id = ((await created.json()) as any).entry.id;
    arm(() => sql(`UPDATE articles SET status='published',version=2 WHERE id=${sqlite ? "?" : "$1"}`, [id]));
    check((await response("/entries/" + id + "?collection=articles", "PATCH", { expectedVersion: 2, data: { title: "Unsafe" } })).status === 409, "future lock cannot bypass read draft policy");
    check((await response("/entries", "POST", { collection: "articles", data: { title: "Duplicate", slug: "race" } })).status === 409, "native unique clash rolls back insert");
    const rows = await sql(`SELECT title,status,version FROM articles WHERE id=${sqlite ? "?" : "$1"}`, [id]);
    check(rows[0]!.title === "Before race" && rows[0]!.status === "published" && Number(rows[0]!.version) === 2, "published data remains untouched");
    await sql(`UPDATE articles SET status='draft',version=3 WHERE id=${sqlite ? "?" : "$1"}`, [id]);
    arm(() => sql(`UPDATE articles SET status='published',version=4 WHERE id=${sqlite ? "?" : "$1"}`, [id]));
    check((await response("/entries/" + id + "?collection=articles", "PATCH", { expectedVersion: 3, data: { title: "Unsafe after lock" } })).status === 409, "atomic SQL lock rejects later publish");
}
