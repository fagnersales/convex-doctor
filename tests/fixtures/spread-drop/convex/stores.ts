import { v } from "convex/values";
import { query } from "./_generated/server";

// handler drops `secret` via destructure-rest — validator must NOT include it.
// This fixture is "clean" w.r.t. drop logic.
export const getStoreSafe = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.string(),
      // secret intentionally excluded — handler drops it
      memberRole: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const store = await ctx.db.get(args.storeId);
    if (!store) return null;
    const { secret, ...rest } = store;
    return { ...rest, memberRole: "Admin" };
  },
});
