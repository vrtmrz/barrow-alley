/**
 * The sole reviewed workaround for browser globals used by host-neutral code.
 *
 * Obsidian uses `window`; Node.js interoperability tests use `globalThis`.
 * Keep direct global access here so production modules remain explicit about
 * crossing that runtime boundary.
 */
export const compatGlobal: typeof globalThis = typeof window === "undefined" ? globalThis : window;
