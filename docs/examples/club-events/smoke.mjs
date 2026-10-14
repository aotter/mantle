// Club events acceptance: only listed members sign up; officers create events in Admin, members register/cancel their own seats over REST and MCP.
import assert from "node:assert/strict";
import { smoke } from "./smoke-kit.mjs";

await smoke(async ({ call, mcp, signIn, sql, owner, step, logs }) => {
  assert.equal((await call("POST", "/api/registrations", { body: { eventId: "x" } })).status, 401);
  assert.equal((await call("GET", "/api/views/events")).status, 401);
  step("anonymous: register and the event list are 401");

  const admin = await signIn(owner);
  assert.equal((await call("GET", "/admin/api/me", { cookie: admin })).body.role.split(",")[0], "admin");
  step("ADMIN_EMAIL signs in although the members list is empty, and becomes the officer (admin)");

  // A verified email that is not on the list: the code is sent, but creating the account is refused.
  const stranger = "stranger@example.test", ip = "198.51.100.7", logStart = logs().length;
  assert.equal((await call("POST", "/api/auth/email-otp/send-verification-otp", { body: { email: stranger, type: "sign-in" }, ip })).status, 200);
  let code;
  for (let i = 0; i < 40 && !code; i++) {
    code = /stranger@example\.test: one-time code is (\d{6})/.exec(logs().slice(logStart))?.[1];
    if (!code) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(code, "no one-time code for the stranger");
  const refused = await call("POST", "/api/auth/sign-in/email-otp", { body: { email: stranger, otp: code }, ip });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.headers.getSetCookie().length, 0);
  assert.equal((await sql(`SELECT count(*) AS n FROM user WHERE email = '${stranger}'`))[0].n, 0);
  step("an email not on the members list cannot sign up: 403, no session cookie, no user row");

  for (const name of ["alice", "bob", "carol", "dave", "erin", "frank"]) {
    const added = await call("POST", "/admin/api/entries", { cookie: admin, body: { collection: "members", data: { email: `${name}@example.test`, name } } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
  const mixed = await call("POST", "/admin/api/entries", { cookie: admin, body: { collection: "members", data: { email: "Grace@example.test" } } });
  assert.ok(mixed.status >= 400 && mixed.status < 500, JSON.stringify(mixed.body));
  step("the officer adds members to the allowlist in Admin (a mixed-case email is refused by the lowercase check)");
  const create = async (title, seats, closed = false) => {
    const created = await call("POST", "/admin/api/entries", { cookie: admin, body: { collection: "events", data: { title, startsAt: "2026-11-01T10:00:00Z", capacity: seats, closed } } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
  };
  await create("Hike", 3);
  await create("Workshop", 1);
  await create("Members' dinner", 10, true);
  step("an officer (admin) creates events with their seats in Admin");

  const alice = await signIn("alice@example.test");
  const events = async cookie => Object.fromEntries((await call("GET", "/api/views/events", { cookie })).body.rows.map(e => [e.title, e]));
  const { Hike: hike, Workshop: workshop, "Members' dinner": dinner } = await events(alice);
  const seatsOf = async id => (await sql(`SELECT capacity - seats_taken AS seats_left FROM events WHERE id = '${id}'`))[0].seats_left;
  const mine = async cookie => (await call("GET", "/api/views/my-registrations", { cookie })).body.rows;

  const registered = await call("POST", "/api/registrations", { cookie: alice, body: { eventId: hike.id } });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.equal(await seatsOf(hike.id), 2);
  assert.deepEqual((await mine(alice)).map(r => r.title), ["Hike"]);
  step("a member registers: the insert and seats_left 3 -> 2 run in one program");

  const twice = await call("POST", "/api/registrations", { cookie: alice, body: { eventId: hike.id } });
  assert.equal(twice.status, 409, JSON.stringify(twice.body));
  assert.equal(await seatsOf(hike.id), 2);
  step("registering twice is 409 (uniqueIndexes [eventId, member]) and takes no seat");

  assert.equal((await call("POST", "/api/registrations", { cookie: alice, body: { eventId: dinner.id } })).status, 409);
  assert.equal((await call("POST", "/api/registrations", { cookie: alice, body: { eventId: "no-such-event" } })).status, 404);
  step("the register handler checks first: a closed event is 409, a missing one 404");

  const bob = await signIn("bob@example.test");
  const [aliceHike] = await mine(alice);
  assert.deepEqual(await mine(bob), []);
  const foreign = await call("POST", "/api/registrations/cancel", { cookie: bob, body: { id: aliceHike.id } });
  assert.equal(foreign.status, 409, JSON.stringify(foreign.body));
  assert.equal((await sql(`SELECT count(*) AS n FROM registrations WHERE id = '${aliceHike.id}'`))[0].n, 1);
  assert.equal(await seatsOf(hike.id), 2);
  step("another member neither sees nor cancels it: cancel is 409, the row and seats_left are unchanged (restrict)");

  const racers = [];
  for (const name of ["carol", "dave", "erin", "frank"]) racers.push(await signIn(`${name}@example.test`));
  const race = await Promise.all(racers.map(cookie => call("POST", "/api/registrations", { cookie, body: { eventId: workshop.id } })));
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409, 409, 409], JSON.stringify(race.map(r => r.body)));
  assert.equal(await seatsOf(workshop.id), 0);
  assert.equal((await sql(`SELECT count(*) AS n FROM registrations WHERE eventId = '${workshop.id}'`))[0].n, 1);
  step("four members race for the last seat: exactly one wins, seats_left is 0, the losers' inserts rolled back");

  const cancelled = await call("POST", "/api/registrations/cancel", { cookie: alice, body: { id: aliceHike.id } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(await seatsOf(hike.id), 3);
  assert.deepEqual(await mine(alice), []);
  step("the member cancels their own registration and the seat returns (2 -> 3)");

  assert.ok((await mcp("/mcp", bob)).body.result.tools.some(t => t.name === "register"));
  const viaAi = await mcp("/mcp", bob, "register", { eventId: hike.id });
  assert.equal(viaAi.body.result?.isError, undefined, JSON.stringify(viaAi.body));
  assert.equal(await seatsOf(hike.id), 2);
  assert.deepEqual((await mine(bob)).map(r => r.title), ["Hike"]);
  step("the member's AI registers through the public MCP tool `register`");

  const all = await call("GET", "/admin/api/entries?collection=registrations", { cookie: admin });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.items.map(r => r.data.eventId).sort(), [hike.id, workshop.id].sort());
  assert.equal((await call("GET", "/admin/api/entries?collection=registrations", { cookie: bob })).status, 403);
  assert.equal((await call("GET", "/admin/api/me", { cookie: bob })).status, 403);
  assert.ok(all.body.items.every(r => r.data.memberName && r.data.memberName !== r.data.member), JSON.stringify(all.body.items));
  step("officers see every member's registrations, with names, through Admin's API; a member gets 403 on Admin");

  const entry = async id => (await call("GET", `/admin/api/entries/${id}?collection=events`, { cookie: admin })).body.entry;
  const before = await seatsOf(hike.id), version = (await entry(hike.id)).version;
  const forced = await call("PATCH", `/admin/api/entries/${hike.id}?collection=events`, { cookie: admin, body: { data: { seats_taken: 0 }, expectedVersion: version } });
  assert.ok(forced.status >= 400 && forced.status < 500, JSON.stringify(forced.body));
  const shrunk = await call("PATCH", `/admin/api/entries/${hike.id}?collection=events`, { cookie: admin, body: { data: { capacity: 0 }, expectedVersion: version } });
  assert.ok(shrunk.status >= 400 && shrunk.status < 500, JSON.stringify(shrunk.body));
  assert.equal(await seatsOf(hike.id), before);
  step("Admin cannot write the server-maintained seats_taken (readOnly), nor lower capacity below the seats taken");
});
