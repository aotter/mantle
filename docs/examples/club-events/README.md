# Club events

A club's event sign-up. Officers (the `admin` layer) create events with their seats in the Admin console; signed-in
members list events, register, and see and cancel only their own registrations, from a page or through their own AI
over MCP. Only members the officers listed in Admin can sign up. Officers see every registration in Admin. Seats never oversell, even when members race for the last one.

## Capabilities shown

- **Member-owned rows**: `restrict: { registrations: "author_id = auth.uid()" }` on the `my-registrations` View and the
  `cancel-registration` Procedure (`manifests/club-events.yaml`). Registrations have no field `scope`, which would hide
  rows from officers too; Admin lists all of them.
- **No duplicates**: `uniqueIndexes: [[eventId, member]]`. Native `authorId` is not allowed in a unique index, so the
  `register` handler writes `member` from the verified caller (`src/handlers.ts`); a second registration is 409.
- **Capacity that never oversells**: officers edit `capacity`; `seats_taken` is a `readOnly` property, so Admin's
  generic edit never writes it, and `checks: ["seats_taken <= capacity"]` guards both. `register-write` inserts the
  registration and adds to `seats_taken` in one program, so a full event fails the check and the insert rolls back;
  `cancel-registration` returns the seat in the same program as the delete.
- **A `ref` handler that checks before writing**: `register` refuses a missing (404) or closed (409) event, then calls
  the internal SQL Procedure. It does not pre-check seats: the database check is what holds under concurrency.
- **Who registered**: the handler stores a `memberName` snapshot from Better Auth's `user` row, since `member` is an
  opaque id; Admin's registration list shows it.
- **Members-only sign-up**: officers list members' emails in the `members` Schema in Admin (unique, lower case by a
  Schema check; no View or Trigger exposes it). `src/signup.ts` replaces the shell's allow-all `allowSignUp` with a
  Store lookup as a system caller, so any other email gets 403 at sign-in and no account. To invite another officer
  through Admin, list their email in `members` first.
- **Member MCP tool**: the `register-mcp` Trigger (`surface: public`) exposes `register` on `/mcp`, so the member's AI
  registers with the member's own sign-in.

## Combine with

- Need members to see only their own rows? Add a `restrict: { <schema>: "author_id = auth.uid()" }` like `my-registrations`.
- Need a stock, quota or budget that never goes negative? A `readOnly` counter, a Schema `checks`, and a relative
  `UPDATE ... SET n = n + 1` in the same Procedure as the write.
- Need invite-only sign-up? club-events' members allowlist + `src/signup.ts`.
- Need "one per member"? A handler-written column from `caller.subject` in `uniqueIndexes`.

## Run it

```sh
cp -R node_modules/@aotter/mantle/docs/examples/app-shell/. my-app/
cp -R node_modules/@aotter/mantle/docs/examples/club-events/. my-app/
cd my-app && pnpm install && pnpm generate && pnpm types && pnpm check
cp .dev.vars.example .dev.vars && pnpm db:init && pnpm dev
pnpm smoke
```

Members use `GET /api/views/events`, `GET /api/views/my-registrations`, `POST /api/registrations { eventId }` and
`POST /api/registrations/cancel { id }`. AGENT: build the member pages in `src/routes.ts` (the shell's Admin console is
for officers only).

## What `pnpm smoke` proves

Anonymous calls are 401. `ADMIN_EMAIL` signs in with an empty members list; an email not on the list gets a code but
its sign-in is 403 and creates no user row. The officer adds the members in Admin (a mixed-case email is refused), and
they sign in. An officer creates events in Admin. A member registers (seats 3 → 2); registering twice is 409
and takes no seat; a closed event is 409 and a missing one 404. Another member cannot see or cancel the registration
(cancel is 409; the row and seats stay). Four members race for a 1-seat event: exactly one succeeds, the rest are 409,
no seat is left and only one row exists. Cancelling returns the seat. A member registers through the MCP tool.
The officer sees every registration, with the member's name, through Admin's API; a member gets 403 on Admin.
Admin cannot write `seats_taken` or lower `capacity` below the seats taken.
