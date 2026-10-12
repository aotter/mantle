/** Bun owns files; no SQLite, runtime or compiler import enters this optional host reader. */
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Same reader contract as the Admin options' assets(path, request, env). */
export function bunAdminAssets(root: string): (path: string) => Promise<Response | null> {
  const base = resolve(root);
  return async path => {
    try { path = decodeURIComponent(path); } catch { return null; }
    if (/[\u0000-\u001f\\]/.test(path)) return null;
    const target = resolve(base, `.${path}`);
    if (!target.startsWith(`${base}${sep}`)) return null;
    const physical = await realpath(target).catch(() => "");
    if (!physical || !physical.startsWith(`${await realpath(base)}${sep}`)) return null;
    return new Response(Bun.file(physical));
  };
}
