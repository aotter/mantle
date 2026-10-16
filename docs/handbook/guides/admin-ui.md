# Customize Admin from manifests

Select `--admin` and mount [native Admin](native-admin.md) from `@aotter/mantle-admin`. The app serves its assets and owns authentication. UI and SDK are separate packages.

Schema `uiSchema` selects fields, widgets, list columns, enum tabs and child navigation. The compiler derives sortable fields from indexed required/non-null fields; it emits selected system/statistics indexes in initial DDL. Apply those indexes through an explicit migration on existing databases.

Admin Views provide custom read lists; their SELECT outputs, column lineage and `uiSchema.list` define display/search/filter metadata. Procedures and MCP admin Triggers define operations with declared authorization, input checks and optional row targets. A hidden button never authorizes an operation.

Generic publishing edits apply to drafts; publishing transitions retain their atomic guards and OCC. Read-only collections refuse generic edits while declared Procedures can still run. Ref operations receive the caller/transaction-bound Store.

Use [`defineAdmin` components](native-admin.md#customising-admin) for app-owned cells, inputs, record asides and actions; server work is a Procedure, a View or an application route. Keep exact conflict/uncertain-outcome handling in the shared UI controller.

## Theme

Admin is themed with CSS variables. Import your own stylesheet from `src/admin.tsx` (`import "./admin.css"`) and override the public tokens on `:root` for light and on `.dark` for dark:

```css
:root {
  --primary: #0f766e;
  --primary-foreground: #ffffff;
  --radius: 0.5rem;
}
.dark {
  --primary: #2dd4bf;
  --primary-foreground: #042f2e;
}
```

Admin marks the active theme as both the `.dark` class and `data-theme="dark"` (or `"light"`) on the root. Dark tokens and Tailwind's `dark:` variant apply when either is present, so `[data-theme="dark"] {}` is equivalent to `.dark {}`. Your overrides apply in the browser Admin; the [MCP App](mcp-apps.md#theme) uses its own palette.

| Token | Meaning |
| --- | --- |
| `--background` | Page background |
| `--foreground` | Default text |
| `--card` | Card and panel surface |
| `--card-foreground` | Text on a card |
| `--popover` | Menu, popover and dialog surface |
| `--popover-foreground` | Text on a popover |
| `--primary` | Brand color: primary buttons, active states |
| `--primary-foreground` | Text on `--primary` |
| `--secondary` | Secondary button surface |
| `--secondary-foreground` | Text on `--secondary` |
| `--muted` | Subtle surface: table stripes, disabled areas |
| `--muted-foreground` | Secondary text |
| `--accent` | Hover and selected surface |
| `--accent-foreground` | Text on `--accent` |
| `--destructive` | Destructive actions and errors |
| `--border` | Borders and dividers |
| `--input` | Form control borders |
| `--ring` | Focus ring |
| `--radius` | Base corner radius; the other radii derive from it |
| `--success` | Success status color |
| `--warning` | Warning status color |
| `--info` | Informational status color |
| `--chart-1` | Chart series 1 |
| `--chart-2` | Chart series 2 |
| `--chart-3` | Chart series 3 |
| `--chart-4` | Chart series 4 |
| `--chart-5` | Chart series 5 |
| `--sidebar` | Sidebar surface |
| `--sidebar-foreground` | Sidebar text |
| `--sidebar-primary` | Sidebar active item |
| `--sidebar-primary-foreground` | Text on `--sidebar-primary` |
| `--sidebar-accent` | Sidebar hover surface |
| `--sidebar-accent-foreground` | Text on `--sidebar-accent` |
| `--sidebar-border` | Sidebar borders |
| `--sidebar-ring` | Sidebar focus ring |
| `--app-base` | Solid color behind the page |
| `--app-background` | Page backdrop (any CSS background, such as a gradient) |

Every other variable, including `--mantle-blue-*` and `--chrome-glass`, is internal and may change without notice.

## Eject a component

`@aotter/mantle-admin` ships a [shadcn registry](https://ui.shadcn.com/docs/registry) of starting-point components for the `defineAdmin` slots. Ejecting copies one into your source: you own that file and edit it freely, while the hooks it calls (`@aotter/mantle-admin/hooks`) and the slot prop types (`@aotter/mantle-admin/app`) keep upgrading with the package. The registry is inside the installed package, so the copy matches the version you run and nothing is fetched from a host. Install from the package, in the app's root:

```bash
npx shadcn@latest add ./node_modules/@aotter/mantle-admin/dist/registry/admin-cell.json
```

The file lands in `src/admin/<item>.tsx` (the app needs a `components.json`, as for any shadcn item; the item's `target` ignores its aliases). Import it in `src/admin.tsx` and name the slot, replacing the sample collection, field, View and operation with your own:

```tsx
import { AdminCell } from "./admin/admin-cell";

export default defineAdmin(admin, { components: { "cell:requests.status": AdminCell } });
```

| Item | Slots | Surface |
| --- | --- | --- |
| `admin-cell` | `cell:<schema>.<field>`, `cell:view:<view>.<column>` | both |
| `admin-input` | `input:<schema>.<field>` | both |
| `admin-record-actions` | `record.actions:<schema>` (runs an operation with `useOperation`) | both |
| `admin-record-aside` | `record.aside:<schema>` (lists a View's rows with `useView`) | both |
| `admin-sidebar` | `Sidebar` (`renderDefault` with a footer link) | browser |
| `admin-home` | `Home` (`renderDefault` under a section that reads a View) | browser |

Each file starts with a comment naming its surface and rules, and imports only `react`, `@aotter/mantle-admin/app` and `@aotter/mantle-admin/hooks`. A `both` component also renders in the Admin MCP App, inside a host's sandboxed iframe, so keep it to these rules:

- Read data only through `useView` and `useOperation`; `useEntries`, `useEntry`, `useCollectionTotal` and `useMe` read `unavailable` there. Declare what a card needs as an admin View.
- Link only with `<AdminLink>` or `useOpenLink()`; never `window.open` or `target="_blank"`.
- No `fetch`, no `document.cookie` or `localStorage` authentication, no remote origin that the host's CSP does not allow, and no assumed width.
- Branch on `useAdminSurface()` (or the `surface` prop) if you must, and render something sensible in both branches.
