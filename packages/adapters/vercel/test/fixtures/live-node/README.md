# Vercel Node.js live fixture

Set this directory as the Vercel project's Root Directory and provide
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and a high-entropy
`MANTLE_SMOKE_KEY`. The function rejects local/file URLs so canonical state is
always remote durable storage.

After a preview deploy:

```bash
VERCEL_SMOKE_URL=https://preview.example \
MANTLE_SMOKE_KEY=... \
pnpm smoke:live
```

The smoke writes and publishes one unique order, then reads it in a later View
invocation and exercises the manifest HTTP Trigger plus the sibling health
route. Delete the preview project and its test database when no longer needed.

Keep this local live fixture until a maintained downstream Vercel consumer
provides the same deployment proof.
