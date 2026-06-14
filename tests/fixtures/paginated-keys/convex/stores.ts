import { v } from "convex/values";
import { query } from "./_generated/server";

const ROW = v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() });

// Missing isDone + continueCursor → two MISSING_FIELD.
export const pageBad = query({
  args: { opts: v.any() },
  returns: v.object({ page: v.array(ROW) }),
  handler: async (ctx, args) => await ctx.db.query("stores").paginate(args.opts),
});

// Full paginated envelope → clean.
export const pageOk = query({
  args: { opts: v.any() },
  returns: v.object({ page: v.array(ROW), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => await ctx.db.query("stores").paginate(args.opts),
});
