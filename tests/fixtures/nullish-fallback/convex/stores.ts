import { v } from "convex/values";
import { query } from "./_generated/server";

const RET = v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() });

// `?? <non-null>` → result non-null → clean.
export const fbNonNull = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.id);
    const b = await ctx.db.get(args.id);
    if (!b) throw new Error("missing");
    return a ?? b;
  },
});

// `?? null` → still nullable → NULL_BRANCH fires.
export const fbNull = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.id);
    return a ?? null;
  },
});

// `?? <nullable>` → still nullable → NULL_BRANCH fires.
export const fbNullable = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.id);
    const c = await ctx.db.get(args.id);
    return a ?? c;
  },
});
