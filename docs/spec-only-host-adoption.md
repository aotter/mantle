# Spec-only adoption in an existing host

An existing application can reuse Mantle's Schema grammar and validation by
consuming the published `@aotter/mantle-spec` package, without running Mantle
Runtime. This Spec-only path is allowed by
[ADR-0019](adr/0019-sealed-manifest-runtime-pipeline.md), not a new adapter,
manifest grammar, or fork of Core.

This recipe targets `0.1.0-alpha.16`. Its public APIs and peer requirements are
prerelease contracts: pin the package, record the tested version, and rerun
compatibility checks when upgrading.

## What stays with the host

| Concern | Spec reuse | Host responsibility |
|---|---|---|
| Model definitions | Schema grammar, parse/link diagnostics | Project existing definitions into supported JSON Schema |
| Input | `EntryDataValidator` and structured errors | Authentication, authorization, normalization, write orchestration |
| Model browser | Parsed/linked Schema metadata | UI, metadata visibility, field display, graph layout |
| Relationships | Translation declaration/link validation | Existing slug joins, record integrity, locale policy |
| Storage and publishing | None in this recipe | Files, database, transactions, revisions, release/recovery |
| Operations and tools | None in this recipe | No automatic View, Procedure, Trigger, REST or MCP execution |

Mantle's Web, Admin UI and platform adapters remain optional. A Vue host does
not have to embed the React Admin SPA to reuse Spec. Avoid importing SDK
internals or maintaining a second manifest interpreter.

## One definition, several projections

The motivating Aotter official-website implementation keeps its existing
Nuxt/Nitro host and Git/D1 storage. Shared content definitions drive the site's
content layer, admin write validation, a responsive model/ER browser, and
Schema export. That website implementation was validated locally; this SDK
contribution does not deploy it or claim a production rollout.

```text
Host-owned content definitions
  ├─ existing CMS/content queries
  └─ JSON Schema in Mantle Schema manifests
       ├─ parse + link → model browser / metadata export
       └─ EntryDataValidator → host-authorized write path
```

Use the existing definitions as the source of truth. If the host starts with
Zod or another schema language, conversion is a host concern: verify that the
result uses supported JSON Schema keywords and preserves the intended
validation semantics. Do not hand-maintain a second field list for the graph.

## Minimal public-API recipe

Install the exact Spec package and its supported peer, without Runtime:

```sh
npm install --save-exact @aotter/mantle-spec@0.1.0-alpha.16 zod@4.5.4
```

The [synthetic fixture](../packages/mantle-spec/test/fixtures/spec-only-host.yaml)
contains categories, articles and article translations. It contains no real
website records, account configuration or credentials. Given that fixture as
`manifestYaml`, the application can prepare its validated model once:

```ts
import {
  EntryDataValidator,
  parseManifestSources,
  ValidateManifestsUseCase,
} from "@aotter/mantle-spec";

const parsed = parseManifestSources({
  sources: [{ sourceId: "host:content-model", text: manifestYaml }],
});
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));

const checked = ValidateManifestsUseCase.run({
  parsed: parsed.value,
  siteLocales: ["zh-TW", "en-US"],
});
if (checked.errorCount || !checked.linked) {
  throw new Error(JSON.stringify(checked.diagnostics));
}

const article = checked.linked.schemas.find(
  ({ manifest }) => manifest.metadata.name === "articles",
)!.manifest;
const validator = new EntryDataValidator();
const diagnostics = validator.validate(article, { category: 42 }, { partial: true });
// INPUT_VALIDATION_FAILED at /category. The host must reject the write.
```

The non-null assertion is specific to this known fixture. A dynamic host must
handle an unknown collection explicitly and fail closed. Do not fabricate
sealed parser/linker values or re-parse the same revision in each request.

`EntryDataValidator` returns diagnostics, not a sanitized payload. It does not
persist, authorize, coerce the original object, or enforce storage integrity.
Normalize explicitly in the host before validation and write only after
successful validation and authorization. An `additionalProperties: true`
compatibility policy accepts legacy fields; it is not a reason to expose those
fields publicly.

`partial: true` relaxes top-level required fields for drafts, while still
checking supplied types and nested required fields. Validate without `partial`
when the host needs a complete record, alongside its own publication rules.
Create a fresh validator for each model revision: its compiled cache is keyed
by manifest name (and partial/full mode), not by a changing schema body.

## Honest ER diagrams and metadata export

- Derive model nodes and field details from Schema properties. Use a small
  host-owned relationship registry for relations not represented by Mantle
  grammar; show logical joins distinctly from actual database foreign keys.
- The fixture's `x-example-source` and `x-example-relations` live inside JSON
  Schema. They are illustrative vendor annotations, **not new Mantle keys or
  executable relationship definitions**. Core may preserve them without
  interpreting them. The host must validate their shape and endpoint fields.
- Do not label a filename/slug join as `x-mantle-ref`: that keyword represents
  Mantle entry-ID references. A category slug matching a key inside a YAML
  array remains a host-specific relation, not a generated SQL foreign key.
- `translates` validates the parent and join-field declarations, not whether
  actual translation records exist. A Spec-only host still owns allowed
  locales, uniqueness, fallback, and orphan handling. See
  [ADR-0010](adr/0010-locale-and-translates.md); Runtime locale/storage gates
  are not installed by this recipe.
- A read-only inventory can add derived fields such as filename `slug` or
  directory `locale` without changing stored files. Document that projection;
  it is not evidence that existing data is ready for Runtime import.
- The fixture uses JSON Schema `readOnly` as an inventory annotation. It is
  not a security boundary: entry validation does not enforce host write
  permissions. Export only after applying the host's metadata access policy.
- Exclude credential/account models and private data. Export schemas, not
  records. Where appropriate, require an administrator and use
  `Cache-Control: private, no-store` for model and export endpoints.
- Keep the graph usable on narrow screens: searchable model selection,
  focused relationships, zoom/scroll, keyboard controls and a field-table
  alternative. A graph must not be the only accessible representation.

## Reproducible evidence

From this SDK checkout:

```sh
pnpm --filter @aotter/mantle-spec test -- test/spec-only-host.test.ts
pnpm --filter @aotter/mantle-spec typecheck
```

The [regression test](../packages/mantle-spec/test/spec-only-host.test.ts)
exercises the public export surface, manifest round trips, translation linking,
and strict/partial entry validation without Runtime. It is an SDK regression
fixture, not a new Starter workspace or a certification test suite.

An adopting host must also test its own installed package, real content
compatibility, HTTP authorization/invalid-input paths, metadata exclusions and
responsive UI. Existing data need not be published or uploaded to prove this.
Keep sensitive evidence internal and expose only an agreed verification report.

## Maintainer decision requested: ecosystem identity and recognition

The Aotter website is offered as a first **candidate** for a maintainer-designed
recognition process. This section asks for that design; it does not establish
an official certification, new compatibility tier or permission to use a badge.

Decisions requested from Mantle maintainers:

1. **Presentation:** how should a host show its relationship to Mantle in its
   admin/about UI? Define approved terminology, visual mark and link target,
   including how Spec-only adoption differs from Runtime/module adoption.
2. **Criteria and evidence:** which capabilities are being attested, against
   which exact SDK version, and which checks must be reproducible? Distinguish
   schema validation from runtime interoperability and security review.
3. **Authority and lifecycle:** who can grant recognition, where can a badge
   be independently verified, and when must it be renewed or withdrawn after
   package or application changes? Prevent self-issued marks from implying
   maintainer approval.
4. **Pilot:** what additional evidence should this existing-host candidate
   provide before receiving a mark, without exposing content or credentials?

Until that decision exists, an accurate technical status is **"Spec validation
passed against <exact version>"**, with a tested-capabilities list. It must not
be presented as **"Mantle certified"** or as a guarantee of data migration,
release reliability, security, shared UI components or full Runtime support.

This proposal uses the optional composition in ADR-0019 and respects
[ADR-0018](adr/0018-core-starters-repository-boundary.md): the website remains
an external consumer; the SDK receives only documentation and synthetic tests.
