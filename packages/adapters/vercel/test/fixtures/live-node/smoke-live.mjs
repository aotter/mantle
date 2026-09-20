const baseUrl = requiredEnv("VERCEL_SMOKE_URL").replace(/\/$/, "");
const smokeKey = requiredEnv("MANTLE_SMOKE_KEY");
const customerId = `smoke-${Date.now()}`;

const health = await fetch(`${baseUrl}/health`);
assert(health.status === 200 && await health.text() === "ok", "health route failed");
const seed = await fetch(`${baseUrl}/_smoke/seed`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mantle-smoke-key": smokeKey,
  },
  body: JSON.stringify({ customerId, title: "Vercel durable smoke" }),
});
assert(seed.status === 200 && (await seed.json()).ok === true, "durable seed failed");
const view = await fetch(
  `${baseUrl}/api/views/published-orders?customerId=${encodeURIComponent(customerId)}`,
);
const viewBody = await view.json();
assert(
  view.status === 200 && viewBody?.data?.rows?.[0]?.customerId === customerId,
  "durable View read failed",
);
const trigger = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(customerId)}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ customerId: "spoofed" }),
});
const triggerBody = await trigger.json();
assert(
  trigger.status === 200 && triggerBody?.data?.customerId === customerId,
  "HTTP Trigger failed or accepted a spoofed path field",
);
console.log("Vercel live durable smoke passed.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
