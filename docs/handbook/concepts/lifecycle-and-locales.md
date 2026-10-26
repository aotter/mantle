# Lifecycle and locales

Schemas default to `operational`: rows are live immediately and edit in place. Opt-in `publishing` adds `status` (draft/published/archived), nullable `published_at` and a scope-aware `(published_at, id)` index.

Generated `<table>.publish`, `.unpublish` and `.archive` Procedures take `{ id, expectedVersion }`, require admin/system and perform one atomic UPDATE. Publish checks required fields, visibility, TTL, source state and OCC. A failed guard is `CONFLICT`. Store cannot write status/published_at directly. By default Admin's generic patch edits drafts only (published and archived entries are unpublished first), and a published entry is unpublished before it is deleted; both are an implicit lock named `publishing` that Admin shows before the edit, and neither applies to the transitions. A Store update may edit a published row in place, but never so that `publish` would refuse it: clearing a field `publish` requires is `INPUT_VALIDATION_FAILED` for every caller.

To let admins correct a published entry in place, opt in with `publishing: { liveEdits: true }`. A personal blog needs nothing more than one Schema:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  lifecycle: publishing
  publishing: { liveEdits: true }
  schema:
    type: object
    required: [title, body]
    properties:
      title: { type: string }
      body: { type: string }
```

Admin then edits a published post with a "changes go live on save" notice. The save goes live on commit, `published_at` is kept and `updated_at` moves. The merged post must still pass `publish`'s checks, so emptying its title is refused with `INPUT_VALIDATION_FAILED`. Deleting it still requires unpublishing, and [declared locks](../reference/schema.md#locks) still apply. `publishing` is refused on an operational Schema, which already edits in place. To prepare changes to published content without exposing them, split it into a publishing parent and operational revisions instead ([edit published content without downtime](../guides/revisions.md)).

Public Views see published rows only. Other reads expose drafts only to admin/system. This policy applies to joins and nested queries too.

## Translations

`localized: true` declares a locale string. `translates: { parent, on }` declares a localized child sharing a join key with its parent. A scoped parent needs the same child scope column. A publishing translation can publish only when its caller-visible parent is published (or operational); the parent guard is inside the atomic UPDATE. Unpublishing a parent hides translations without changing their status.

Store translation reads merge visible parent fields, with child fields taking precedence. Authored Views return only their SELECT outputs. Generated `translations.ts` exports `translationLocales(db, caller, parent, rows)` for a parent page (up to 500 storage-named rows); it uses batched authorized child reads rather than one query per parent. Stored locale values remain plain strings; site locales do not rewrite or validate them automatically.

SQLite/PostgreSQL interactive Store transactions refuse to combine translation publication and a parent status change in either order. D1 has no interactive Store transactions. The app owns consistency for native transactions outside Store.

## Expiry

TTL hides expired rows but does not delete them. Use generated system-only `<schema>.sweepExpired` from an application scheduler; [TTL maintenance](../guides/native-execution.md#ttl-maintenance) defines limits and cursors. Until removed, expired rows still occupy unique keys.
