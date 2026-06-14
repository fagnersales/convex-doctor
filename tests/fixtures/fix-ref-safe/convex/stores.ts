import { v } from "convex/values";
import { query } from "./_generated/server";

// blob's schema shape is an unresolved import → fix must NOT emit v.ref() junk.
export const getStore = query({
  args: { id: v.id("stores") },
  returns: v.union(
    v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
