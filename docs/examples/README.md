# Examples hub

This folder is the only official examples tree. Filenames carry the handler class. There is no second Manifest body under `docs/handbook/examples/` — those pages redirect here.

**Builder** may ingest a Manifest only when every Procedure is `handler.kind: builtin` (or the example has no Procedures). That is the `builtin-*` prefix. `cf-primitives-*` documents Durable Objects, Queues, cron, R2, and/or `handler.kind: ref`. `host-*` directories are runnable consumer projects, not business presets.

Drop a `builtin-*` YAML block into `host-local-admin-otp/manifests/` (or `host-minimal-worker/manifests/`) and run `mantle validate`.

| Id / filename | Meaning | Class | Builder | Admin | Related host |
|---|---|---|---|---|---|
| [`builtin-intake.md`](./builtin-intake.md) | Public request form; builtin create; staff list | builtin | yes | optional (staff View / Staff MCP) | `host-minimal-worker` or `host-local-admin-otp` |
| [`builtin-reservation.md`](./builtin-reservation.md) | Public reservation queue; builtin create; staff list | builtin | yes | optional | `host-minimal-worker` or `host-local-admin-otp` |
| [`builtin-publication.md`](./builtin-publication.md) | Localized posts, public list, reader suggestions | builtin | yes | optional (Admin or Staff MCP to draft/publish) | `host-local-admin-otp` |
| [`builtin-procurement.md`](./builtin-procurement.md) | Member requisitions and staff approve/reject with OCC | builtin | yes | optional (Admin or Staff MCP) | `host-local-admin-otp` |
| [`builtin-legal-documents.md`](./builtin-legal-documents.md) | Localized Terms/Privacy revisions and signed-in acceptances | builtin | yes | optional (staff create via MCP; Admin for review) | `host-local-admin-otp` |
| [`builtin-commerce.md`](./builtin-commerce.md) | Product catalog, guest orders, staff fulfill/cancel; builtin create/update only | builtin | yes | optional (Admin or Staff MCP to publish products) | `host-local-admin-otp` |
| [`cf-primitives-intake-hooks.md`](./cf-primitives-intake-hooks.md) | Same intake Schema with Turnstile `before_create` and email `after_create` `ref` hooks | cf-primitives | no | optional | `host-minimal-worker` plus handlers |
| [`cf-primitives-commerce-inventory.md`](./cf-primitives-commerce-inventory.md) | Catalog plus Durable Object stock authority, Queue expiry, payment callback, `ref` handlers | cf-primitives | no | optional | `host-minimal-worker` plus DO/Queue/cron |
| [`cf-primitives-guarded-api.md`](./cf-primitives-guarded-api.md) | API keys, scopes, live entitlement `ref` guards over REST and MCP | cf-primitives | no | none | `host-minimal-worker` plus credential resolver |
| [`host-minimal-worker/`](./host-minimal-worker/README.md) | Executable Spec + adapter without Admin | host | no | none | itself |
| [`host-local-admin-otp/`](./host-local-admin-otp/README.md) | Executable opt-in Admin / Dev UI with email OTP | host | no | required | itself |
| [Mantle on ChatGPT Sites](../handbook/chatgpt-sites/index.md) · [runnable reference](./host-chatgpt-sites/README.md) | Runnable Sites D1/R2, ChatGPT identity, Admin media, published web and public read-only MCP | host | no | required | itself |
