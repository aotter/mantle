import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/public', { recursive: true });
await cp('src/app.mjs', 'dist/app.mjs');
await cp('public/site.css', 'dist/public/site.css');
