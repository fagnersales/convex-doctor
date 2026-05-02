import { v } from "convex/values";
import { query } from "./_generated/server";

// paginated query — validator missing `secret` field on row
export const list = query({
  args: { paginationOpts: v.any() },
  returns: v.object({
    page: v.array(
      v.object({
        _id: v.id("stores"),
        _creationTime: v.number(),
        name: v.string(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    return await ctx.db.query("stores").paginate(args.paginationOpts);
  },
});
