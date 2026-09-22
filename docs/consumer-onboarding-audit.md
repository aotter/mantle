# Consumer onboarding audit for 0.1.3

Scope: source skill install → pinned npm package → CLI → generated skills and
handbook → application manifest and Admin customization. This is maintainer
evidence, not a release announcement. Baseline: develop `b90cebbd`, package
version `0.1.3-alpha.5`; the package version alone does not identify unreleased
commits on develop. Tracking: [#1042](https://github.com/aotter/mantle/issues/1042).

## Clean source install

Executed in an empty temporary directory:

```sh
npx --yes skills add aotter/mantle --skill install --agent codex --yes
```

Observed output: repository cloned, **7 skills found**, **1 selected**, copied
to `./.agents/skills/install`. `skills-lock.json` records source `aotter/mantle`,
source type `github`, and source path `skills/install/SKILL.md`. The installed
file's hash in that lock was
`8a6fd26aea97ae8bdf3e05fef22196c247b3f95aa049204a6ac51259d87e4e29`.
No SDK, handbook or application is installed by that command. The explicit
Codex and noninteractive flags make the audited destination reproducible;
other selected agents/global scope can use another destination.

This source install follows the repository's default ref. It does not test the
unreleased edits in this PR or establish an npm version. The packed-consumer
check below tests this branch's shipped instructions separately.

## White-box path and fixes

| Stage / owner | Finding before this change | Correction |
|---|---|---|
| README → external skills installer | Prompt told the agent to read `skills/install/SKILL.md` and `docs/agent-prompts.md`, neither installed there. | Read the installer-reported destination, then the installed SDK's embedded docs. |
| `skills/install/SKILL.md` | Bootstrap Git instructions did not explicitly hand off to the installed package's own install skill; `docs/...` root was implicit. Host interview was repeated. | Explicit package-root resolution and version authority; ask only for missing requirements. |
| Install → CLI | It was possible to try the local CLI before installing Core; `generate` in an empty directory fails rather than creating a project. | Spell out package installation before CLI and manifest authoring before generation. |
| Quickstart versions | Floating `latest` dependency examples contradicted exact-pin advice. | Resolve the requested channel once and save exact Mantle versions before the first build. |
| `mantle skills` | Correctly projected four project skills, but success output did not tell the agent what to read next. | Print the projected develop skill and installed handbook entry. Document overwrite, drift and opt-in behavior. |
| `sync-package-docs.mjs` → npm `files` | Docs and all seven skills already shipped; presence checks did not protect the new entry paths or exercise projection from the tarball. | Assert handbook/skill files and byte-identical `.agents`/`.claude` projection in the existing packed-consumer check. |
| View concepts → grammar/runtime | Concepts denied internal Views and recommended SQL for every new View; reference `surface` table omitted `internal`. SQL admission text was stale. | Match implemented surfaces, typed declarative reads, SQLite admission sandbox and native-dialect limits. |
| Manifest reference | View's allowed spec keys omitted `cache`; Schema list-column prose omitted native columns. | Reconcile with parser and Admin UI checker. |
| Plugin/update skills | Assumed conventional source paths, missed regeneration after plugin manifest edits, and treated every View as publicly callable. | Use actual project paths, regenerate the plan, verify the declared surface and distinguish stable index from target prerelease docs. |
| Feature discovery | No task-to-manifest capability map or usable human entry; reference was buried after host-specific sections. | Add overview, capability table and task guides; move reference before host guides without breaking existing URLs. |
| Typed query discovery | APIs existed but lacked a complete internal-View calling example or clear reader authorization distinction. | Explain generated params/results, runtime `result` versus REST `data`, SQL `unknown`, indexed reader limits and plan-based emission. |
| Admin requests → theme/develop skills | Theme skill targeted visitor source; no routing from an Admin request to manifest-controlled presentation. | Route to Admin guide, with Schema/View/Procedure rendering table and supported customization ceiling. |
| Auth operations | Store-bound session cache behavior existed in code/ADR but was missing from the handbook. | Explain store identity, preparation order and KV propagation limits. |

## Verification and regression coverage

- `packages/mantle-spec/test/handbook-contract.test.ts`: complete handbook YAML
  examples parse and validate; navigation covers pages; relative links resolve.
- `packages/mantle/test/cli/generate.test.ts`: extracts the new internal-View
  YAML and TypeScript directly from the handbook, generates bindings and runs
  strict TypeScript checking on the real example.
- CLI surface/projection tests assert the concrete next-read destinations;
  existing drift checks verify `--check` is read-only.
- `scripts/check-optional-packages.mjs`: packs and installs the actual Core
  tarball, checks embedded entry pages/skills, runs `skills` and `skills --check`,
  and compares each project projection byte-for-byte with the installed package.
- Repository gate: `pnpm check`. Exact execution results and any environment
  limitations are recorded in the PR, rather than frozen as a future guarantee.

No npm publish, tag, deployment or grammar change is part of this audit. Source
skill consumers receive the corrections only once they reach the installed Git
ref; npm consumers receive them only in a package built from the corrected tree.
