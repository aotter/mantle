import type { MantleHandlers } from "../.mantle/generated/mantle.js";

export const handlers: MantleHandlers = {
  audit: async (_input, ctx) => {
    const page = await ctx.store.view("my-items", { input: { min: 1 }, limit: 10 });
    const label: unknown = page.rows[0]?.label;
    const [item] = (await ctx.store.select({ from: "items", where: { name: String(label) } })).rows;
    await ctx.store.write([{ insert: "items", values: { name: item?.name ?? "copy" } }]);
    // a publishing Schema drafts: an insert may be incomplete, and an update may move the status alone
    await ctx.store.write([{ insert: "posts", values: { body: "draft" } }, { update: "posts", where: { id: "p1" }, set: { status: "published" } }]);
    return {};
  },
  note: (input) => ({ ok: input.text.length > 0 }),
};
