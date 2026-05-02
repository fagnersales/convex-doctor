import { v } from "convex/values";
import { query } from "./_generated/server";

export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.string(),
      ownerId: v.id("users"),
      isActive: v.boolean(),
      description: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
