import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

// Drift bug: the caller's returns validator says `label: v.number()` but
// the called function (helpers.getStatus) returns `label: v.string()`.
// Without runQuery propagation this slips through (we mark unanalyzed).
export const caller = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    label: v.number(),
  }),
  handler: async (ctx) => {
    return await ctx.runQuery(internal.helpers.getStatus, {});
  },
});

// Clean case: same shape, no drift.
export const callerOk = action({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    label: v.string(),
  }),
  handler: async (ctx) => {
    return await ctx.runQuery(internal.helpers.getStatus, {});
  },
});
