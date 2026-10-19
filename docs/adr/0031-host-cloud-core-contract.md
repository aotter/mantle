# ADR 0031: Cloud supplies the host Core pin

Status: Accepted for mantle-host protocols 2, 4, 5 and 6.

The backend artifact includes `sdkVersion` and `sdkRevision` in its hashed
bytes. The old host bundled a fixed Core revision. Cloud can run the previous
Core release, so a host built from current Core cannot assume its own revision
is the revision Cloud accepts. Asking only the backend upload grant is too
late: that grant requires the artifact hash first.

`save` now preflights the project and emits `cloud-host-contract` with the
project ID. Control returns `{ projectId, core: { version, revision }, protocol }`
from the deployed Cloud configuration. The script validates the project,
40-hex revision and protocol minimum before packing. It persists the pin and
backend hash together. Upload grants, HTTP responses and the frontend kit must
echo the same pin; a difference fails before another upload and requires a new
save. No static Core pin is shipped in the plugin. The script contacts only
the granted Cloud HTTP endpoints; the contract comes through the Cloud MCP
tool, like upload grants.

Protocol 2 changes the MCP save sequence and requires both Core version and
revision in `kit.json`. Control must provide the contract tool and pin echoes
before this host script is offered to users. A future change to the MCP
sequence, artifact bytes or validation meaning requires a protocol bump. A
new Core release using these same rules changes only the Cloud contract pin.

## Protocol 4: verified project Git source

Protocol 4 changes the save sequence: an ordinary push and Cloud source receipt
precede backend reservation. The receipt binds project/version, commit, target
and Core pin. The helper reads clean committed Git objects, and Cloud checks
the plan/YAML and retained ZIP against that commit. A changed Cloud pin requires
a new source receipt before save; an immutable saved release keeps its stored
bytes for review and rollback. The helper can reopen an existing project with
an authorized short-lived read credential, without creating a new project.

Artifacts repository provisioning, credentials, receipt records, resource
cleanup and deployment policy belong to the Cloud service. Core vendors its exact
helper artifact/checksum and documents the MCP workflow; it gains no provider
adapter, SQL compiler, runtime wiring or new Manifest grammar. Client-built
handlers/static files are not represented as server build attestation.

## Agent orchestration and offline packing (#1368)

Cloud MCP remains protocol 4 and owns lifecycle state and permissions. The plugin
helper no longer mirrors candidate/deploy state or polls Cloud. Its public bundle
contains safe Git source transport and offline backend/frontend/source packing.
The agent discovers MCP schemas, records non-secret operation IDs for identical
retries, and observes server state before publication. Packaging still uses the
installed Core compiler; this is not a Core runtime/provider adapter change.

`pack backend --contract -` validates the project and Cloud pin. `pack frontend`
requires the backend commit and ready kit candidate, and emits immutable hashes.
The agent checks these against reservations and uses native HTTP grant transport.
Cloud admission and plan/archive verification remain unchanged; handler/static
bundles remain client-built. The source transport also rejects secret-named files
in reachable history, without claiming to scan source content for credentials.

## Protocol 5: mandatory structural website acceptance

A shared artifact validator runs in offline frontend packing and host admission,
and the host repeats it before new publication. The uploader cannot disable it
with an artifact flag or a self-reported checklist. A permanent canonical origin
is bound to the immutable static upload receipt and checked against the selected
site at reservation. Current rule/version and frontend hash bind the report;
changing a candidate or bytes requires fresh evidence. Existing stored releases
remain readable and rollback preserves their historical bytes.

The plugin packer requires `--origin` and emits structured missing-check
diagnostics. The upload MCP contract requires `canonicalOrigin`. This changes
validation meaning and therefore increments the host protocol, not the Manifest
grammar or Core runtime. The validator checks built HTML AST structure and
metadata, deterministic sitemap/robots and SPA routing configuration without
executing untrusted code or launching a browser. The host provides Admin, OTP
and media wiring; artifact validation does not certify delivery, uploads,
arbitrary authorization, visual behavior, content truth or dynamic HTML refresh.
A REST-only host must report dynamic-content SEO unsupported.

## Local preparation and additive continuation (#1381)

The existing offline helper may run explicit application check/build argv arrays, pack a clean fixed commit and ordinarily push it in a single `prepare` entry. It returns source-admission arguments and deterministic artifact metadata; no Cloud lifecycle state, HTTP upload, polling or publication is added. Commands cannot silently commit source changes; dirty tracked output fails the existing clean-commit checks. Credentials stay in session memory/stdin. Native host responses may add continuation facts derived from their authoritative resource/lease rows; read-only backend status remains read-only. These additions do not change artifact bytes, admission rules or protocol 5 validation meaning.

## Protocol 6: durable publication and read-only handoff (#1385)

Publication changes the native MCP sequence: one accepted publication operation
continues durably in Cloud, including recoverable provider waits, without an
agent repeatedly advancing deployment steps. The agent observes authoritative
deployment status until terminal; status reads never start or advance work.
Interrupted acceptance is recovered through the same immutable operation and
arguments, not a replacement candidate. Permission revocation and deterministic
refusals remain terminal until their stated correction; background work does not
retain a credential or turn a previous authorization into permanent authority.

This sequence change requires protocol 6. A client must validate that contract
before relying on autonomous publication; it cannot merely poll a protocol 5
host and expect progression. Historical source/release artifacts keep their
identity and rollback rules. The new sequence does not change Manifest grammar
or claim server build attestation. Local preparation and builds stay in the
agent environment; the helper gains no deployment scheduler or build container.
An accepted operation, ready preview or expired preview is not evidence of a
serving release or completed cleanup. Terminal state, access policy and literal
publication URL come from Cloud's authoritative status.
