# @aotter/mantle-admin-ui

Admin SPA shell for mantle.

This package builds a React/Tailwind static bundle. When it is installed,
`mantle generate` copies that bundle to `public/_mantle/admin/` (excluding
`server.*` exports). Core-only projects that omit this package skip the copy.
It currently provides the system admin shell, preference UI, site overview
surfaces, and Mantle-branded system pages.

This package is prerelease software. Its `package.json` is the exact version
authority; the API surface may change until `v0.1.0`.
