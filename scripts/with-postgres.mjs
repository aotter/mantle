#!/usr/bin/env node
/**
 * Runs a command against a throwaway local PostgreSQL cluster: initdb into a temp directory, trust auth on
 * 127.0.0.1 and a free port, the PostgreSQL variables Full checks sets, then always stop and delete the cluster.
 * When all three variables are already set, the command runs against them unchanged; one or two set is an error.
 *
 *   node scripts/with-postgres.mjs <command> [args...]
 *   node scripts/with-postgres.mjs --notice   prints one line when PostgreSQL tests would skip
 *
 * ponytail: limits. SIGINT/SIGTERM/SIGHUP stop the cluster, but `kill -9` of this script leaves the postmaster, its
 * directory and the command running, and a signal sent to this process alone reaches only its direct child, so that
 * child's own children may outlive it. Manual cleanup: the start line names the directory; run
 * `pg_ctl -D <dir>/data -m immediate stop` (as the postgres or nobody user when root) and delete <dir>. The free port is
 * found with listen(0) and closed before PostgreSQL binds it; if another process takes it first, pg_ctl start fails and
 * the run stops (no retry).
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const names = ["MANTLE_PG_URL", "MANTLE_NEXT_BUN_PG_URL", "MANTLE_NEXT_WORKER_PG_URL"];
const missing = names.filter(name => !process.env[name]);
const set = names.filter(name => process.env[name]);
const [command, ...args] = process.argv.slice(2);

if (command === "--notice") {
  if (set.length) {
    if (missing.length)
      console.log(
        `\nPostgreSQL tests PARTLY SKIPPED (${missing.join(", ")} unset). Set all three, or run: pnpm check:pg`,
      );
  } else {
    const files = spawnSync("git", ["grep", "-l", "-E", "MANTLE_(NEXT_(BUN|WORKER)_)?PG_URL", "--", "*.test.ts"], {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
    }).stdout?.match(/\n/g)?.length;
    console.log(
      `\nPostgreSQL tests SKIPPED (${names.join(", ")} unset${files ? `; ${files} test files have PostgreSQL cases` : ""}). Run them: pnpm check:pg`,
    );
  }
  process.exit(0);
}
if (!command) throw new Error("Usage: with-postgres.mjs <command> [args...] | --notice");
if (set.length && missing.length) {
  console.error(
    `with-postgres: set all three PostgreSQL variables or none (set: ${set.join(", ")}; unset: ${missing.join(", ")})`,
  );
  process.exit(1);
}

let child;
let cleanup = () => {};
process.on("exit", () => cleanup());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => (child ? child.kill(signal) : process.exit(128 + constants.signals[signal])));

const env = { ...process.env };
if (missing.length) {
  const versioned = (parent, prefix, bin = "bin") => {
    try {
      return readdirSync(parent)
        .filter(name => name.startsWith(prefix))
        .sort((a, b) => parseFloat(b.slice(prefix.length)) - parseFloat(a.slice(prefix.length)))
        .map(name => join(parent, name, bin));
    } catch {
      return [];
    }
  };
  const binDir = [
    ...(process.env.PATH ?? "").split(":"),
    spawnSync("pg_config", ["--bindir"], { encoding: "utf8" }).stdout?.trim(),
    ...versioned("/usr/lib/postgresql", ""), // Debian, Ubuntu
    ...versioned("/usr", "pgsql-"), // RHEL, Fedora (PGDG)
    ...versioned("/opt/homebrew/opt", "postgresql@"),
    ...versioned("/usr/local/opt", "postgresql@"),
    "/opt/homebrew/opt/postgresql/bin",
    "/usr/local/opt/postgresql/bin",
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
  ].find(dir => dir && existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")));
  if (!binDir) {
    console.error(
      "with-postgres: no PostgreSQL server binaries (initdb, pg_ctl) on PATH, at `pg_config --bindir` or in common install\n" +
        "locations. Install PostgreSQL (16, as in CI), or point MANTLE_PG_URL, MANTLE_NEXT_BUN_PG_URL and\n" +
        "MANTLE_NEXT_WORKER_PG_URL at a disposable database yourself, for example a container:\n" +
        "  docker run --rm -d -p 5432:5432 -e POSTGRES_USER=mantle -e POSTGRES_PASSWORD=mantle postgres:16\n" +
        "  export MANTLE_PG_URL=postgres://mantle:mantle@127.0.0.1:5432/mantle (and the other two, same value),\n" +
        "then run this again: with all three set, it uses them instead of starting a cluster.",
    );
    process.exit(1);
  }

  // initdb and postgres refuse to run as root: as root (a container), run the cluster as an unprivileged user, in /tmp
  // because that user may not be able to enter root's TMPDIR.
  const root = process.getuid?.() === 0;
  const user = root ? ["postgres", "nobody"].find(name => id("-u", name)) : undefined;
  if (root && !user) {
    console.error("with-postgres: as root, the cluster runs as the postgres or nobody user, and neither exists");
    process.exit(1);
  }
  const dir = mkdtempSync(join(root ? "/tmp" : tmpdir(), "mantle-pg-"));
  const data = join(dir, "data");
  const owner = user ? { uid: Number(id("-u", user)), gid: Number(id("-g", user)) } : {};
  if (user) chownSync(dir, owner.uid, owner.gid);
  const pg = (name, args, stdio = "inherit") => spawnSync(join(binDir, name), args, { ...owner, stdio });
  cleanup = () => {
    if (existsSync(join(data, "postmaster.pid"))) pg("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], "ignore");
    rmSync(dir, { recursive: true, force: true });
  };

  const port = await new Promise((done, fail) => {
    const server = createServer().once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
  const step = (name, args) => {
    const result = pg(name, args, ["ignore", "ignore", "inherit"]);
    if (result.status !== 0) {
      const log = join(dir, "server.log"); // deleted on exit, so show it now
      if (existsSync(log)) process.stderr.write(readFileSync(log));
      console.error(`with-postgres: ${name} failed${user ? ` (as ${user})` : ""}`);
      process.exit(1);
    }
  };
  step("initdb", ["-D", data, "-U", "mantle", "-A", "trust", "-E", "UTF8", "--locale=C"]);
  appendFileSync(
    join(data, "postgresql.conf"),
    `listen_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`,
  );
  step("pg_ctl", ["-D", data, "-l", join(dir, "server.log"), "-w", "start"]);
  step("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "mantle", "mantle"]);
  // Same user, password and database as full-checks.yml; trust auth ignores the password.
  for (const name of names) env[name] = `postgres://mantle:mantle@127.0.0.1:${port}/mantle`;
  console.error(
    `with-postgres: PostgreSQL (${binDir}) on 127.0.0.1:${port}${user ? ` as ${user}` : ""}, data in ${dir}`,
  );
}

child = spawn(command, args, { stdio: "inherit", env });
child.on("error", error => {
  console.error(`with-postgres: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? 128 + constants.signals[signal]));

function id(flag, name) {
  const result = spawnSync("id", [flag, name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
