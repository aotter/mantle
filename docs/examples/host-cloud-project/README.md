# Cloud project build reference

This runnable consumer combines a publishing Schema, public View, `ref`
Procedure, Worker-compatible frontend module, and one static asset. Its
`package.json` declares the version 1 `mantle build` contract. In CI the
packed-consumer verifier installs the selected SDK tarballs in a fresh
directory, repeats installation with `--frozen-lockfile`, then runs `pnpm test`.

The checked-in `latest` SDK spec is rewritten to the exact packed version only
inside that disposable verifier. For a real app, pin the exact published SDK
version and commit its lockfile. Upload the local artifact for independent
Cloud validation; it does not authorize deployment by itself. This fixture is
the new-project path. Existing Mantle SDK frontends need their own adoption
fixture and public content should use the matching `@aotter/mantle-web` package.
