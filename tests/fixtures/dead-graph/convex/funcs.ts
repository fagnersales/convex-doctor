import { query, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Referenced from ../app.ts via useQuery(api.funcs.alive) — alive.
export const alive = query({
  args: {},
  handler: async () => null,
});

// No references anywhere — dead (direct tier).
export const deadDirect = internalQuery({
  args: {},
  handler: async () => null,
});

// Dead entry point: nothing references it, but it references deadHelper.
export const deadParent = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.funcs.deadHelper, {});
  },
});

// Referenced ONLY by deadParent — dead (transitive tier).
export const deadHelper = internalQuery({
  args: {},
  handler: async () => 1,
});

// Self-scheduling paged migration: its only reference is its own self-call,
// which must not count as life — dead (transitive tier).
export const selfLoop = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.funcs.selfLoop, {});
  },
});

// convex-doctor: keep — run manually via `npx convex run` by ops
export const keptFn = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.funcs.keptHelper, {});
  },
});

// Referenced only by keptFn, which is a declared-alive root — alive.
export const keptHelper = internalQuery({
  args: {},
  handler: async () => 2,
});

// Referenced from ../scripts/run.ts by string name "funcs:stringCalled" — alive.
export const stringCalled = internalQuery({
  args: {},
  handler: async () => 3,
});

// Matched by the --ignore-dead pattern in the test — treated as a live root.
export const ignoredParent = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.funcs.ignoredHelper, {});
  },
});

// Referenced only by ignoredParent; alive while the ignore pattern is on.
export const ignoredHelper = internalQuery({
  args: {},
  handler: async () => 4,
});
