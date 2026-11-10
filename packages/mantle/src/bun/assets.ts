/** Bun owns files; no SQLite, runtime or compiler import enters this optional host reader. */
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Native file response, or null for missing or invalid paths. Every file gets `nosniff`; Admin's content-hashed
 * chunks under `/assets/` are cached for a year, as the edge `_headers` does on Workers. Other files keep no cache
 * header (`adminShell` marks the shell `no-store`). */
export function bunAdminAssets(root: string): (path: string) => Promise<Response | null> {
  const base = resolve(root);
  return async path => {
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (/[\u0000-\u001f\\]/.test(path)) return null;
    const target = resolve(base, `.${path}`);
    if (!target.startsWith(`${base}${sep}`)) return null;
    const physical = await realpath(target).catch(() => "");
    if (!physical || !physical.startsWith(`${await realpath(base)}${sep}`) || !(await stat(physical)).isFile())
      return null;
    const headers = new Headers({ "x-content-type-options": "nosniff" });
    if (path.startsWith("/assets/")) headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(Bun.file(physical), { headers });
  };
}
