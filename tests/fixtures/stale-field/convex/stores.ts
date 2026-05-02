import { v } from "convex/values";
import { query } from "./_generated/server";

// validator has `legacyField` that schema dropped
export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.string(),
      legacyField: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
