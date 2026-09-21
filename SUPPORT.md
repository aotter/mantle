# Support

## How to get help

1. **Skim docs first** — [README](./README.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and the ADRs at [`docs/adr/`](./docs/adr/).
2. **General questions** — file under [Discussions](https://github.com/aotter/mantle/discussions) (Q&A, Ideas, Show and tell).
3. **Bug or feature request** — file an [issue](https://github.com/aotter/mantle/issues/new/choose).
4. **Security** — do **not** open a public issue. See [SECURITY.md](./SECURITY.md).

## For AI agents

**Consumers** (authoring or embedding a Mantle application): start with the
install skill, then the CLI and handbook.

```sh
npx skills add aotter/mantle --skill install
```

Follow [`skills/install/SKILL.md`](skills/install/SKILL.md) and
[task-specific agent prompts](docs/agent-prompts.md). After
`@aotter/mantle` is installed, the same files live under
`node_modules/@aotter/mantle/`. Interview for host and surfaces before writing
files. Authoring docs and the CLI are how you learn Mantle; a deployed
`/mcp` catalog is the live app's Manifest → RuntimePlan verbs, not a second
getting-started guide.

**Contributors** (changing this SDK): [`AGENTS.md`](./AGENTS.md) is the
contributor router. It is not shipped in the npm tarball.

## Legacy Starters

The retired alpha.17 Starter source and bundles remain in
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters). File
legacy issues there. New applications use [direct authoring](docs/handbook/start/project-and-cli.md).

## What we don't offer

No paid support tier today. Aotter does not provide commercial SLA or production on-call for community
users. For commercial engagement, contact `phsu@aotter.net`.
