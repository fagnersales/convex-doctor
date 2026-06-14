import { v } from "convex/values";
import { query } from "./_generated/server";

// audit comes from the spread group — validator omits secret → drift.
export const getAudit = query({
  args: { id: v.id("audit") },
  returns: v.union(
    v.object({ _id: v.id("audit"), _creationTime: v.number(), action: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
