import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

// Called by `caller` below via ctx.runQuery(internal.helpers.getStatus, ...)
export const getStatus = internalQuery({
  args: {},
  returns: v.object({
    ok: v.boolean(),
    label: v.string(),
  }),
  handler: async () => {
    return { ok: true, label: "alive" };
  },
});
