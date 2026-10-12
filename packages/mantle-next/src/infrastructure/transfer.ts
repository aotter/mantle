/** Thin CLI over generated transfer functions and the application's own native driver module. */
import { createReadStream, createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";

export async function transfer(command: "export" | "import", paths: string[]): Promise<void> {
  const [generated, driver, file] = paths;
  if (paths.length !== 3) throw new Error("Usage: mantle export|import <generated/transfer.js> <driver-module.js> <dump.ndjson|->");
  let owner: { db: unknown; dispose?: () => Promise<void> } | undefined;
  try {
    const application = await import(pathToFileURL(resolve(generated!)).href);
    owner = await import(pathToFileURL(resolve(driver!)).href);
    if (!owner?.db) throw Error("Driver module must export db.");
    if (command === "export") await application.exportStore(owner.db).pipeTo(Writable.toWeb(file === "-" ? process.stdout : createWriteStream(file!, { flags: "wx", mode: 0o600 })));
    else await application.importStore(owner.db, Readable.toWeb(file === "-" ? process.stdin : createReadStream(file!)));
  } catch {
    throw Error("Storage transfer failed; inspect the configured adapter privately. Do not switch bindings to an incomplete import target.");
  } finally { if (owner?.dispose) try { await owner.dispose(); } catch { throw Error("Driver disposal failed."); } }
}
