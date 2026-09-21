# Upgrading to 0.1.2

0.1.2 is the first stable release and the first public one. There is no earlier
stable to upgrade from and no migration to perform.

What it contains, what it requires and what it does not yet cover is in
[Releases](handbook/releases/index.md).

Every version before 0.1.2 was an internal prerelease. If you are holding a
database created by one of those, `LEGACY_STORAGE_RESET_REQUIRED` means it
predates native Schema tables: rebuild it rather than migrating it. Move any
data you need out of Mantle by hand first — there is no product migration for
that unreleased storage format.
