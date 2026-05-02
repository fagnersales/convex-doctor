import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator missing `cachedAvailableBalance` — classic drift bug.
export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.string(),
      ownerId: v.id("users"),
      isActive: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
