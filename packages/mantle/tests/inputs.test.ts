import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUTS_FILE, authTableSql, extraRoles, inputsFingerprint, staleInputs } from "../src/infrastructure/inputs.js";

test("generated output is stale once a recorded input changes or disappears", () => {
  const root = mkdtempSync(join(tmpdir(), "mantle-inputs-")), generated = join(root, "generated");
  try {
    mkdirSync(generated);
    const manifest = join(root, "app.yaml"), auth = join(root, "auth.ts");
    writeFileSync(manifest, "kind: Schema\n"); writeFileSync(auth, "export {}\n");
    writeFileSync(join(generated, INPUTS_FILE), inputsFingerprint(generated, [manifest, auth]));
    const module = join(generated, "generated.ts");
    expect(staleInputs(module)).toEqual([]);
    appendFileSync(manifest, "# edit\n");
    expect(staleInputs(module)).toHaveLength(1);
    rmSync(auth);
    expect(staleInputs(module)).toHaveLength(2);
    expect(staleInputs(join(root, "elsewhere", "generated.ts"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("roles beyond admin and user are named for a design note", () => {
  expect(extraRoles(`roles: { admin: ac.newRole(x), user: ac.newRole({}) }`)).toEqual([]);
  expect(extraRoles(`roles: { admin: ac.newRole(x), "org-manager": ac.newRole({ user: ["list"] }), approver: ac.newRole({}) }`)).toEqual(["org-manager", "approver"]);
});

test("SQL against Better Auth's tables is named for a design note", () => {
  expect(authTableSql('db.prepare(`SELECT email FROM "user" WHERE id = ?`)')).toEqual(["user"]);
  expect(authTableSql("SELECT * FROM session s JOIN account a ON a.userId = s.userId")).toEqual(["session", "account"]);
  expect(authTableSql("SELECT * FROM users; SELECT user_id FROM orders; const fromUser = 1")).toEqual([]);
});
