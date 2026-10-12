# Admin extensions

Pass a module exporting `adminExtensions` (named or default) to
`mantle generate ... --admin-extensions ./extensions.ts`. The generator checks
full declarations and manifest UI bindings, then emits `admin-extensions.ts`.
Programmatic binding-only `{ id, contributes }` metadata retains its existing
compiler use; it produces no server extension module. Full declarations use
`apiVersion: 1`, kebab IDs, localized titles and the existing contribution targets.
OSS contribution roles are `staff`; omitted field roles default to `staff`.
Owner/editor/contributor role names must be changed to `staff` when upgrading.

```ts
import type { AdminExtension } from '@aotter/mantle/admin/extensions';
export const adminExtensions = [{ apiVersion: 1, id: 'settings', title: 'Settings',
  contributes: { settings: [{ id: 'display', title: 'Display', role: 'staff',
    schema: { type: 'object', properties: { enabled: { type: 'boolean' } },
      required: ['enabled'] } }] },
  handlers: { settings: { display: {
    load: async (caller, context) => loadDisplay(context.db, caller),
    save: async (caller, value, context) => saveDisplay(context.db, caller, value)
  } } }
}] satisfies readonly AdminExtension<Env, Database>[];
```

The app owns those native DB operations. Use the generated Store with
`store(context.db, context.caller)` when accessing scoped content. Keep writes
and their OCC/transaction handling in the handler; the SDK adds no runtime plan,
registered handler, hook or storage facade.

```ts
import { admin } from './generated/admin.js';
import { adminExtensions } from './generated/admin-extensions.js';
import { adminExtensions as definitions } from './extensions.js';
const options = { db: (env: Env) => env.DB, caller, assets, handlers };
const extension = adminExtensions(definitions, options);
const console = admin({ ...options, ...extension,
  routes: [...otherAdminRoutes, ...extension.routes] });
```

Keep the generated declarations and the runtime definitions together. A changed
or duplicated declaration, missing/extra handler, or invalid source type fails
setup with `UI_EXTENSION_INVALID`. Rerun generate/typecheck after changing the
contribution contract. Executable callbacks remain application-owned.

Settings support the same finite form subset as 0.2: string/number/integer/boolean,
required fields, enum/oneOf constants, numeric bounds and Unicode character lengths.
Checks compile into direct code; no runtime schema interpreter is loaded. PATCH
`/admin/api/x/<extension>/settings/<id>` takes `{ value }`; invalid values return 400
with `error.fields`, and GET returns `{ value }`. Unknown fields and inherited
values do not satisfy required properties. Integer checks preserve `Number.isInteger`;
irrelevant bounds on another primitive type remain ignored as in 0.2.

Actions use POST `/admin/api/x/<extension>/actions/<id>` and preserve record,
selection (1–1000 IDs), or list-schema payloads. Their `when.schema` is checked
before the handler runs; dialogs are client-rendered and have no server run route.
Extension API hooks retain every method under `/admin/api/x/<extension>/api/<path>`
and receive `{ request, url, env, db, caller, params, extension, path }`.
`path` preserves the original URL tail, including trailing slashes, as in 0.2. A null
response is 404. API responses default to `no-store`; an explicit handler cache
header is preserved. Settings/actions stay `no-store`.

Every API and source-module request uses Admin's current cookie-session `staff`
gate. OAuth/API keys, anonymous callers and other roles do not gain access.
Cookie writes retain the shared same-origin check. Handlers receive the verified
Caller plus native `{ request, url, env, db, params }` context; callbacks accepting
only the old caller/value arguments still work. The site response contains only
public contribution metadata, never callbacks, source code or integrity.

Modules use either a same-origin absolute `module` path (optional sha256/384/512
`integrity`) or `source` string/loader. Source modules are served at
`/admin/extensions/<id>.js` with `private, no-cache` and `nosniff`. Source loads
and SHA-384 computation happen only on a selected Admin shell/module request,
are cached once per mounted extension set, and retry after failure. The HTML
shell needs the source hash before browser imports, so its first request may call
the loader; `/site`, settings/actions and unrelated surfaces do not. The shell
merges integrity into its existing import map and escapes `<` to preserve the
script boundary. The SDK preview document remains untouched.

The browser's canonical `@aotter/mantle-ui/extension` renderer protocol/import map
stays unchanged. Use `ADMIN_EXTENSION_JSON_SCHEMA` and `diffAdminExtensions` from
`@aotter/mantle/admin/extensions/tooling` for review tools. They are a separate
pure leaf; request handlers do not import the tooling/compiler. The diff compares
public declarations/contributions, and does not compare executable source/handlers.
