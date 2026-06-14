import { v } from "convex/values";
import { query } from "./_generated/server";

// Direct `return result.page` → rows<stores>; validator omits secret → drift.
export const listPage = query({
  args: { opts: v.any() },
  returns: v.array(v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() })),
  handler: async (ctx, args) => {
    const result = await ctx.db.query("stores").paginate(args.opts);
    return result.page;
  },
});
