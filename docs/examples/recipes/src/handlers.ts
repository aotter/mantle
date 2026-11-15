import { ContractError } from "@aotter/mantle/contracts";
import type { Handlers } from "../generated/generated.js";

export const handlers: Handlers = {
  save_recipe: async ({ store }, { slug }) => {
    // Check before writing: only a recipe this member may read (published) can be saved. The Store is bound to the
    // caller, so `slug` is never trusted beyond the input schema; `owner` is filled from the caller in save_recipe_write.
    if (!(await store.collection("recipes").first({ where: { slug } }))) throw new ContractError("NOT_FOUND", "No such recipe.", "procedures/save_recipe");
    return store.procedures.save_recipe_write({ slug });
  },
};
