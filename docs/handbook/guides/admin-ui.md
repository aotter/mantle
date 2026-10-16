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

Admin marks the active theme as both the `.dark` class and `data-theme="dark"` (or `"light"`) on the root, in the browser and in an [MCP host](mcp-apps.md#theme). Dark tokens and Tailwind's `dark:` variant apply when either is present, so `[data-theme="dark"] {}` is equivalent to `.dark {}`, and your `.dark {}` overrides apply in both places.

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
