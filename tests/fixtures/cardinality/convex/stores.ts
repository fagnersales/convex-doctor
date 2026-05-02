import { v } from "convex/values";
import { query } from "./_generated/server";

// handler returns array via .collect() but validator says single object
export const listStores = query({
  args: {},
  returns: v.object({
    _id: v.id("stores"),
    _creationTime: v.number(),
    name: v.string(),
  }),
  handler: async (ctx) => {
    return await ctx.db.query("stores").collect();
  },
});
