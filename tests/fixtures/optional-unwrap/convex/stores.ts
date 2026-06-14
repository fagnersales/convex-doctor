import { v } from "convex/values";
import { query } from "./_generated/server";

// Object hidden inside v.optional(...) is still diffed → MISSING_FIELD secret.
export const getOpt = query({
  args: { id: v.id("stores") },
  returns: v.optional(v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() })),
  handler: async (ctx, args) => ctx.db.get(args.id),
});

// Valid primitive vs v.optional(v.string()) → clean (no false TYPE_MISMATCH).
export const primOk = query({
  args: {},
  returns: v.optional(v.string()),
  handler: async (ctx) => "x",
});
