import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator omits two schema fields the handler returns (it returns the raw doc):
//  - `isActive` (REQUIRED)  → always present → ALWAYS throws → error
//  - `cachedAvailableBalance` (OPTIONAL) → throws only when set → warn
export const getStore = query({
  args: { storeId: v.id("stores") },
  returns: v.union(
    v.object({
      _id: v.id("stores"),
      _creationTime: v.number(),
      name: v.string(),
      ownerId: v.id("users"),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.storeId);
  },
});
