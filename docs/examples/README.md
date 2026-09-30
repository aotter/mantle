# Examples hub

| Example | What it shows |
|---|---|
| [`reference-service/`](./reference-service/README.md) | A runnable 0.2.0 service: scoped orders, SQL Views and Procedures, hooks, a cron, REST, both MCP surfaces, Admin's API and console email-OTP sign-in. The release gate runs it. |

The `builtin-*` and `cf-primitives-*` pages are 0.1.x manifests (`apiVersion:
cms.mantle.aotter.net/v1`). 0.2.0 refuses them. They stay as worked inputs for
[the upgrade guide](../upgrade-0.1-to-0.2.md) until they are ported to v2.
