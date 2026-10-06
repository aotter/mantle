# ADR 0031: Cloud supplies the host Core pin

Status: Accepted for mantle-host protocol 2.

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
