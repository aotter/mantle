import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

await import("./ensure-dev-vars.mjs");

const require = createRequire(import.meta.url);
const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
const ownerEmail = "owner@example.com";
const port = 18787;
const origin = `http://127.0.0.1:${port}`;
const logs = [];

const wrangler = spawn(process.execPath, [
  wranglerBin,
  "dev",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  String(port),
  "--inspector-port",
  "0",
  "--persist-to",
  ".wrangler/smoke",
], {
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

const onLog = (chunk) => {
  logs.push(String(chunk));
};
wrangler.stdout.on("data", onLog);
wrangler.stderr.on("data", onLog);

try {
  await waitForReady(origin);
  const signIn = await fetch(`${origin}/admin/sign-in`);
  assert.equal(signIn.status, 200, `/admin/sign-in ${signIn.status}`);
  const html = await signIn.text();
  assert.match(html, /<!doctype html|<html/i);
  const assets = [...html.matchAll(/(?:href|src)="(\/_mantle\/admin\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((path, index, all) => all.indexOf(path) === index);
  assert.ok(assets.length > 0, "Admin HTML must reference /_mantle/admin assets");
  for (const path of assets) {
    const asset = await fetch(`${origin}${path}`);
    assert.equal(asset.status, 200, `${path} ${asset.status}`);
  }

  const methods = await fetch(`${origin}/api/auth/methods`);
  assert.equal(methods.status, 200);
  assert.deepEqual(await methods.json(), { methods: [{ kind: "email-otp" }] });

  const sent = await fetch(`${origin}/api/auth/email-otp/send-verification-otp`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, type: "sign-in" }),
  });
  assert.equal(sent.status, 200, `send OTP ${sent.status} ${await sent.text()}`);
  const otp = await waitForOtp();
  const signedIn = await fetch(`${origin}/api/auth/sign-in/email-otp`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, otp }),
  });
  assert.equal(signedIn.status, 200, `sign-in ${signedIn.status} ${await signedIn.text()}`);
  const cookie = cookieHeader(signedIn);
  assert.ok(cookie, "sign-in must set a session cookie");

  const shell = await fetch(`${origin}/admin`, { headers: { cookie } });
  assert.equal(shell.status, 200, `/admin ${shell.status}`);
  const settings = await fetch(`${origin}/admin/api/site-settings`, { headers: { cookie } });
  assert.equal(settings.status, 200, `/admin/api/site-settings ${settings.status}`);
  const pkg = JSON.parse(readFileSync("node_modules/@aotter/mantle/package.json", "utf8"));
  console.log(`Mantle ${pkg.version}: /admin assets 200, OTP ${otp} in wrangler logs, owner Admin shell 200`);
} finally {
  wrangler.kill("SIGTERM");
  await waitForExit(wrangler);
}

function cookieHeader(response) {
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return cookies.map((value) => value.split(";", 1)[0]).join("; ");
}

async function waitForReady(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null) {
      throw new Error(`wrangler exited ${wrangler.exitCode}\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${url}/admin/sign-in`);
      if (response.status === 200) return;
    } catch {
      // Worker still booting.
    }
    await delay(250);
  }
  throw new Error(`wrangler did not become ready\n${logs.join("")}`);
}

async function waitForOtp() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = logs.join("").match(/Your Mantle sign-in code: (\d{6})/);
    if (match) return match[1];
    await delay(100);
  }
  throw new Error(`OTP log line missing\n${logs.join("")}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
