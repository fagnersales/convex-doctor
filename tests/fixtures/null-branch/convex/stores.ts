import { v } from "convex/values";
import { query } from "./_generated/server";

// validator forgot v.null() but handler can return null via .first()
export const firstStore = query({
  args: {},
  returns: v.object({
    _id: v.id("stores"),
    _creationTime: v.number(),
    name: v.string(),
  }),
  handler: async (ctx) => {
    return await ctx.db.query("stores").first();
  },
});
