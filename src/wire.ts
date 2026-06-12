import type { AppContext } from "./tools/context.js";

/** Wires concrete services into the context. Grows as layers land:
 * scaffold → null services (tools return MAP_NOT_BUILT / LSP_UNAVAILABLE). */
export async function initServices(_ctx: AppContext): Promise<void> {
  // map service: phase 3-4; live pool: phase 5; bridge: phase 6.
}
