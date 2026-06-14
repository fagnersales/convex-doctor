import { v } from "convex/values";
import { query } from "./_generated/server";

// Optional stale field → info (dead weight, never throws).
export const optStale = query({
  args: { id: v.id("stores") },
  returns: v.union(
    v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string(), ghost: v.optional(v.string()) }),
    v.null(),
  ),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
