import { ContractError } from "@aotter/mantle/contracts";
import type { Handlers } from "../generated/generated.js";
import { notifyUser } from "./notify.js";
import { placeOrder } from "./supplier.js";

type Decided = { id: string; title: string; amount: number; authorId: string };

export const handlers: Handlers = {
  "approve-request": async ({ store }, input) => {
    let decided: Decided;
    try {
      // One transaction: the guarded status change, the budget deduction and the ledger row.
      decided = (await store.procedures["approve-request-write"](input)).results[0]![0] as Decided;
    } catch (error) {
      // The declared budget check is a business refusal, not a server error. Nothing was written.
      // The approval's only Schema check is the budget one.
      if (error instanceof ContractError && error.code === "CONFLICT" && error.message.startsWith("A check of the Schema failed"))
        throw new ContractError("CONFLICT", "The department budget cannot cover this request.", "procedures/approve-request");
      throw error;
    }
    // After commit: nothing below may turn the committed approval into an error response.
    const ordered = await placeOrder(store, decided);
    await notifyUser(decided.authorId, `Approved: ${decided.title}`,
      `Your purchase request "${decided.title}" was approved${ordered ? " and ordered from the supplier" : ""}.`, "purchasing.approved");
    return { id: decided.id, requestStatus: ordered ? "ordered" : "approved" };
  },
  "reject-request": async ({ store }, input) => {
    const decided = (await store.procedures["reject-request-write"](input)).results[0]![0] as Decided;
    await notifyUser(decided.authorId, `Rejected: ${decided.title}`,
      `Your purchase request "${decided.title}" was rejected.`, "purchasing.rejected");
    return { id: decided.id, requestStatus: "rejected" };
  },
};
