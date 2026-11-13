import { fixtureCaller } from "./apps/fixtures.js";
import { test, expect } from "bun:test";
import { nativeRest, body, type Route } from "../src/kernel/rest.js";
import type { Caller } from "../src/kernel/contracts.js";
const caller: Caller = fixtureCaller({
  kind: "user",
  subject: "a",
  role: "admin",
  admin: true,
  scopes: [],
  credential: "session",
  credentialId: null,
  clientId: null,
});
test("native REST hook preserves Request/env/custom Response and gates before providers", async () => {
  let resolutions = 0,
    providers = 0,
    dispatches = 0;
  const env = { marker: 17 };
  const routes: Route<{ marker: number }, never, typeof env>[] = [
    {
      method: "PATCH",
      pattern: /^\/admin\/api\/raw\/([^/]+)\/?$/,
      keys: ["id"],
      bodyLimit: 4,
      rawBody: true,
      handle: async (request, e, getDb, c, params) => {
        dispatches++;
        expect(e).toBe(env);
        expect(getDb()).toBe(env);
        expect(getDb()).toBe(env);
        expect(c).toBe(caller);
        expect(params.id).toBe("a b");
        return new Response(await request.text(), {
          status: 202,
          statusText: "App reply",
          headers: { "cache-control": "private,max-age=2" },
        });
      },
    },
  ];
  const fetch = nativeRest(routes, {
    caller: () => {
      resolutions++;
      return caller;
    },
    db: e => {
      providers++;
      return e;
    },
  });
  const ask = (method: string, headers: Record<string, string> = {}, value = "ok") =>
    fetch(
      new Request("https://app.test/admin/api/raw/a%20b/", {
        method,
        headers,
        body: method === "PATCH" ? value : undefined,
      }),
      env,
    );
  const denied = await ask("PATCH", { origin: "https://foreign.test" });
  expect(denied?.status).toBe(403);
  expect(providers).toBe(0);
  const huge = await ask("PATCH", { origin: "https://app.test", "content-length": "5" }, "12345");
  expect(huge?.status).toBe(400);
  expect(providers).toBe(0);
  const response = await ask("PATCH", { origin: "https://app.test" });
  expect(response?.status).toBe(202);
  expect(response?.statusText).toBe("App reply");
  expect(response?.headers.get("cache-control")).toBe("private,max-age=2");
  expect(await response?.text()).toBe("ok");
  expect([resolutions, providers, dispatches]).toEqual([3, 1, 1]);
  const wrong = await ask("GET");
  expect(wrong?.status).toBe(405);
  expect(wrong?.headers.get("allow")).toBe("PATCH");
  expect(resolutions).toBe(3);
});
test("shared JSON body limit rejects declared and actual bytes", async () => {
  await expect(body(new Request("https://app.test", { method: "POST", body: '{"x":1}' }), 4)).rejects.toMatchObject({
    code: "INPUT_VALIDATION_FAILED",
  });
  expect(await body(new Request("https://app.test", { method: "POST", body: '{"x":1}' }), 7)).toEqual({ x: 1 });
});

test("an application's own route reads a JSON body with its own refusal", async () => {
  class Refused extends Error {}
  const refuse = (message: string): never => {
    throw new Refused(message);
  };
  const post = (text: string | ReadableStream<Uint8Array>, headers?: Record<string, string>) =>
    new Request("https://app.test/own", { method: "POST", body: text, headers, duplex: "half" } as RequestInit);
  const refusal = async (request: Request, limit = 16) => {
    const error = await body(request, limit, refuse).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Refused);
    return (error as Error).message;
  };
  expect(await body(post('{"email":"a@b.c"}'), 16 + 2, refuse)).toEqual({ email: "a@b.c" });
  expect(await body(post(""), 16, refuse)).toEqual({});
  expect(await refusal(post("{"))).toBe("Expected a JSON body.");
  for (const text of ["[]", "null", "3"]) expect(await refusal(post(text))).toBe("Expected a JSON object.");
  expect(await refusal(post(`{"x":"${"a".repeat(20)}"}`))).toBe("Request body exceeds 16 bytes.");
  // chunked, no content-length: refused once the streamed bytes pass the limit
  const chunks = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode('{"a":1}'));
      c.close();
    },
  });
  expect(await refusal(post(chunks))).toBe("Request body exceeds 16 bytes.");
  // a declared length over the limit is refused before the body is read
  const unread = new ReadableStream<Uint8Array>({
    pull() {
      throw Error("declared oversized stream was read");
    },
  });
  expect(await refusal(post(unread, { "content-length": "17" }))).toBe("Request body exceeds 16 bytes.");
  expect(unread.locked).toBe(false);
});

test("a refusal that returns instead of throwing still refuses", async () => {
  const calls: string[] = [];
  const careless = (message: string) => void calls.push(message) as never;
  const post = (text: string | ReadableStream<Uint8Array>, headers?: Record<string, string>) =>
    new Request("https://app.test/own", { method: "POST", body: text, headers, duplex: "half" } as RequestInit);
  const refused = { code: "INPUT_VALIDATION_FAILED", path: "rest" };
  await expect(body(post(`{"x":"${"a".repeat(32)}"}`), 16, careless)).rejects.toMatchObject(refused);
  await expect(body(post("[1]"), 16, careless)).rejects.toMatchObject(refused);
  await expect(body(post("{"), 16, careless)).rejects.toMatchObject(refused);
  const unread = new ReadableStream<Uint8Array>({
    pull() {
      throw Error("declared oversized stream was read");
    },
  });
  calls.length = 0;
  await expect(body(post(unread, { "content-length": "17" }), 16, careless)).rejects.toMatchObject(refused);
  expect(calls).toEqual(["Request body exceeds 16 bytes."]);
  expect(unread.locked).toBe(false);
});

test("native REST database acquisition is lazy and memoized even for undefined handles", async () => {
  let calls = 0;
  const fetch = nativeRest(
    [
      {
        method: "GET",
        pattern: /^\/api\/metadata$/,
        handle: async (_request, _env, getDb) => {
          expect(calls).toBe(0);
          expect(getDb()).toBeUndefined();
          expect(getDb()).toBeUndefined();
          return { ok: true };
        },
      },
    ],
    {
      caller: () => caller,
      db: () => {
        calls++;
        return undefined;
      },
    },
  );
  expect(await (await fetch(new Request("https://app.test/api/metadata"), {}))?.json()).toEqual({ ok: true });
  expect(calls).toBe(1);
  const refuse = nativeRest(
    [
      {
        method: "GET",
        pattern: /^\/api\/metadata$/,
        handle: async () => {
          throw new Error("configured API refused before storage");
        },
      },
    ],
    {
      caller: () => caller,
      db: () => {
        calls++;
        return undefined;
      },
    },
  );
  const error = console.error;
  console.error = () => {};
  try {
    expect((await refuse(new Request("https://app.test/api/metadata"), {}))?.status).toBe(500);
    expect(calls).toBe(1);
  } finally {
    console.error = error;
  }
});

test("JSON body stream bounds bytes, cancels overflow and preserves split UTF-8", async () => {
  const bytes = new TextEncoder().encode('{"text":"台灣🙂"}');
  let cancellations = 0;
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
  const request = () => new Request("https://app.test", { method: "POST", body: stream(), duplex: "half" });
  expect(await body(request(), bytes.length)).toEqual({ text: "台灣🙂" });
  const largeBytes = new TextEncoder().encode(JSON.stringify({ text: "台灣🙂".repeat(1024) }));
  let offset = 0;
  const tinyChunks = new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === largeBytes.length) c.close();
      else c.enqueue(largeBytes.subarray(offset, ++offset));
    },
  });
  expect(
    await body(
      new Request("https://app.test", { method: "POST", body: tinyChunks, duplex: "half" }),
      largeBytes.length,
    ),
  ).toEqual({ text: "台灣🙂".repeat(1024) });
  const overflow = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancellations++;
      throw Error("secondary cancel failure");
    },
  });
  await expect(
    body(new Request("https://app.test", { method: "POST", body: overflow, duplex: "half" }), 4),
  ).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
  expect(cancellations).toBe(1);
  expect(overflow.locked).toBe(false);
  for (const text of ["", "   \n"]) {
    expect(await body(new Request("https://app.test", { method: "POST", body: text }))).toEqual({});
  }
  for (const text of ["{", "[]", "null", "true", "3"]) {
    await expect(body(new Request("https://app.test", { method: "POST", body: text }))).rejects.toMatchObject({
      code: "INPUT_VALIDATION_FAILED",
    });
  }
  const unconsumed = new ReadableStream<Uint8Array>({
    pull() {
      throw Error("declared oversized stream was read");
    },
  });
  await expect(
    body(
      new Request("https://app.test", {
        method: "POST",
        body: unconsumed,
        duplex: "half",
        headers: { "content-length": "1000001" },
      }),
    ),
  ).rejects.toMatchObject({ code: "INPUT_VALIDATION_FAILED" });
  expect(unconsumed.locked).toBe(false);
  // a limit that is not a positive safe integer is the route's programming error, never the request's
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    let refused = 0;
    await expect(
      body(new Request("https://app.test", { method: "POST", body: "{}" }), limit, message => {
        refused++;
        throw Error(message);
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(refused).toBe(0);
  }
});

test("ordinary REST GET startup excludes the request-only JSON reader", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises"),
    { join } = await import("node:path"),
    { bundle, startupGraph } = await import("../src/infrastructure/bundle.js");
  const dir = await mkdtemp(join(import.meta.dir, "apps/.json-reader-size-"));
  try {
    const entry = join(dir, "worker.ts");
    await writeFile(
      entry,
      'import {rest} from "@aotter/mantle/rest";export default{fetch:rest([{method:"GET",pattern:/^\\/api\\/static$/,query:()=>({input:{}}),page:async()=>({rows:[]})}],{db:()=>null,caller:()=>({kind:"anonymous"} as const)})};',
    );
    const meta = await bundle(entry, join(dir, "bundle")),
      graph = startupGraph(meta, entry);
    expect(
      Object.keys(meta.outputs).some(path =>
        Object.keys(meta.outputs[path]!.inputs).some(input => input.endsWith("/kernel/json-body.js")),
      ),
    ).toBe(true);
    expect(
      graph.some(path =>
        Object.keys(meta.outputs[path]!.inputs).some(
          input => input.endsWith("/kernel/json-body.js") || input.endsWith("/kernel/authorization.js"),
        ),
      ),
    ).toBe(false);
    for (const path of graph)
      expect(await readFile(join(process.cwd(), path), "utf8")).not.toContain("bytes.subarray(0, length)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
