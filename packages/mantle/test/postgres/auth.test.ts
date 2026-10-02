/** Better Auth and Mantle's auth SQL over one PostgreSQL database, as a Worker has them over Hyperdrive. */
import { expect, it } from "vitest";
import { createMantleAuth } from "../../src/auth/index.js";
import { pgDatabaseDriver, pgPool } from "../../src/postgres/index.js";
import { PG_URL, freshSchema } from "./engine.js";

it.skipIf(!PG_URL)("sign-in, the bootstrap owner and staff management run on PostgreSQL", async () => {
  const { connect, drop } = await freshSchema();
  try {
    const codes = new Map<string, string>();
    const auth = createMantleAuth({
      database: pgPool(connect), driver: pgDatabaseDriver(connect), baseURL: "http://localhost", secret: "x".repeat(40), ipAddressHeaders: ["x-real-ip"],
      methods: [{ kind: "email-otp", sender: { send: async ({ to, text }) => void codes.set(to, /\b(\d{6})\b/.exec(text)![1]!) } }],
      bootstrapOwner: { match: "email", value: "owner@x.test" },
    });
    const post = (path: string, body: unknown) =>
      auth.handler(new Request(`http://localhost/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-real-ip": "1.1.1.1" }, body: JSON.stringify(body) }));
    const signIn = async (email: string) => {
      expect((await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50)); // the send is a background task
      const res = await post("/sign-in/email-otp", { email, otp: codes.get(email) });
      expect(res.status).toBe(200);
      return new Request("http://localhost/admin/api/staff", { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
    };

    const owner = await signIn("owner@x.test");
    const [me] = await auth.listUsers(owner);
    expect(me).toMatchObject({ email: "owner@x.test", role: "owner", emailVerified: true });

    const invited = await auth.inviteUser(owner, "ed@x.test", "editor");
    expect(invited.kind).toBe("created");
    expect((await auth.listUsers(owner)).map((u) => [u.email, u.role])).toEqual([["owner@x.test", "owner"], ["ed@x.test", "editor"]]);
    expect(await auth.setUserRole(owner, invited.id, "contributor")).toBe(true);
    expect(await auth.getUserRole(invited.id)).toBe("contributor");

    const member = await signIn("member@x.test");
    await expect(auth.setUserRole(member, invited.id, "owner")).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(await auth.getUserRole((await auth.listUsers(owner))[0]!.id)).toBe("owner");
  } finally {
    await drop();
  }
}, 120_000);
