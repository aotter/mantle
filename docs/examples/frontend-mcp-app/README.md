# Application-owned frontend MCP App

This small React entry uses the official ext-apps `useApp` and optional `mantle-ui` presentation. It imports no `mantle-admin`, Provider, Admin hooks or Admin API. The application owns its build and domain page. Keep React and React DOM pinned to one exact version; install the version-matched Core, optional UI, official ext-apps and its peers. Bundle `app.tsx` into a single-file HTML document containing `<div id="root"></div>` with your browser build tool.

Generate the accompanying manifest with `mantle generate <target> generated manifest.yaml`. Register the built HTML through the existing Core contributor, on the frontend endpoint:

```ts
import { mcp } from "./generated/mcp.js";
const handle = mcp({
  db: env => env.DB,
  caller: request => verifiedCaller(request),
  apps: { public: { resources: [{
    uri: "ui://my-tasks/build-1", name: "my-tasks", renders: ["my_tasks"],
    html: builtHtml,
  }] } },
});
```

`verifiedCaller` is the application's real authentication integration; never derive authority from tool arguments, page state or a user-supplied owner ID. There are no credentials in the HTML. Change the resource URI for a new UI build and update registration consistently. Core owns resource/tool registration and caller enforcement; it neither builds this UI nor imports React. Official ext-apps owns the connection. UI only renders data and invokes callbacks.

`public` names the frontend surface, **not anonymous permission**. `my-tasks` requires a verified user, and the Schema scope limits SQL rows to `auth.uid()`. Admin tools are a separate surface. UI visibility grants no access. The example's load-more calls the same declared View through the host; it does not fetch `/admin/api`. Opening it performs no write. The application reads its consumed row fields and cursor from structured output or a JSON text result; malformed results show an error, a fresh valid result restores the page, and a pending older page cannot append to a newer result. Protocol metadata remains the official client’s responsibility.

Repository acceptance: `bun test packages/mantle/tests/frontend-mcp-app.test.ts` checks generated SQL scope, anonymous/member denials, owner paging and resource linkage. `MANTLE_BROWSER_TESTS=1 MANTLE_TEST_CHROMIUM=/path/to/chrome pnpm --filter @aotter/mantle-admin exec vitest run test/frontend-mcp-app-browser.test.ts` builds this entry without Admin runtime code and renders it in the official AppBridge. The latter command reuses repository browser tooling only; Admin is not an application dependency. This is not an independently installed packed consumer or a real ChatGPT/Claude acceptance result; those remain separate deployment checks.
