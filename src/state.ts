/**
 * Facade for the lifecycle-state domain. Behavior-preserving re-export of the
 * split modules under `src/state/`; import paths from outside remain unchanged.
 */
export * from "./state/shared.js";
export * from "./state/lock.js";
export * from "./state/items.js";
export * from "./state/transitions.js";
export * from "./state/validate.js";
export * from "./state/store.js";
export * from "./state/memory.js";
export * from "./state/lessons.js";
export * from "./state/archive.js";
export * from "./state/lifecycle.js";
export * from "./state/render.js";
