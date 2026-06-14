import { v } from "convex/values";
import { query } from "./_generated/server";

// schema-required + validator-optional → NOT an error (never throws).
export const widened = query({
  args: { id: v.id("stores") },
  returns: v.union(
    v.object({ _id: v.id("stores"), _creationTime: v.number(), req: v.optional(v.string()), opt: v.optional(v.string()) }),
    v.null(),
  ),
  handler: async (ctx, args) => ctx.db.get(args.id),
});

// schema-optional + validator-required → error (the absent field throws).
export const narrowed = query({
  args: { id: v.id("stores") },
  returns: v.union(
    v.object({ _id: v.id("stores"), _creationTime: v.number(), req: v.string(), opt: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
