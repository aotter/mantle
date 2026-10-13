# Site defaults and settings

Select `--site <module>` exporting `siteDefaults`, or pass the same options to programmatic generation. `SiteDefaults` from `@aotter/mantle/site` contains title, brand, description, origin, locales, optional icons and media purposes.

Generation emits the generated site module, deployment DDL for `site_config`, `media_assets`, `pending_media_uploads`, and `site-seed.sql`. Apply initial schema only to an empty database. Apply seed SQL explicitly: only absent brand/title/description are seeded without overwriting edits. Origin, locales, icons and media purposes come from generated defaults. Runtime construction neither seeds nor migrates.

Import the generated `site`, then use `site(db, verifiedCaller).read()` and `.updateSettings({ brand, title, description })`. Media is `site(db, caller).media(storage)`. Native SQLite/PostgreSQL are supported. Only selected modules enter the application bundle.

Admin site/media routes are optional capabilities; their additional admin-cookie gate and origin checks remain required. The app owns object storage, signing and upload CORS. See [media wiring](../cloudflare/media-r2.md).
