import { useSyncExternalStore } from "react";
import type { InteractionController, InteractionState } from "../controller/index.js";

/** The controller's snapshot as React state. */
export function useInteraction(controller: InteractionController): InteractionState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
