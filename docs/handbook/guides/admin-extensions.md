# Extend Admin

Native Admin accepts app-owned extension declarations, executable server handlers and optional same-origin client modules. Import client `defineAdminExtension` from `@aotter/mantle-admin/extension` and UI primitives from `@aotter/mantle-ui/kit`. Server types live in `@aotter/mantle-admin/server`.

| Contribution | Placement |
| --- | --- |
| pages/settings | Extension page; settings forms are generated from the supported form subset |
| actions | record, list selection or list toolbar |
| panels | record sidebar or home |
| fields | field input or cell |

Admin contributions sit behind the admin-layer gate; optional field roles default to `admin`. Server authorization is checked on every route. Handlers own finer business permissions.

Pass full declarations to `mantle generate … --admin --admin-extensions <module>` (named/default `adminExtensions` array). Generation checks contributions, manifest uiSchema references and settings schemas, then emits `extensionMetadata` and compiled `extensionBindings` in `admin-extensions.ts`. Bind the same runtime definitions with `extensionBindings(adminExtensions)` and merge its extensions/routes into `admin()` options. Drift is refused before execution.

Serve each `module` at a same-origin absolute path and install its integrity in the host shell's import map. Native Admin does not serve `source` modules or inject integrity; generation rejects source. Share React and the UI kit via the built import map, rather than bundling a second React. Canonical Admin refuses framing; use its separate same-origin preview contract.

Raw API handlers receive the original Request. Declared `bodyLimit` checks Content-Length before DB access, but the app must bound unknown-length streams. Built-in JSON routes use the shared bounded reader after caller/origin checks. Do not lose exact OCC or uncertain-outcome handling in custom actions.

See [native Admin](native-admin.md) for mounting and acceptance and [generated descriptors](../reference/admin-descriptors.md) for build-time metadata.
