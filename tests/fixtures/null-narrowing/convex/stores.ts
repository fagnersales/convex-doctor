import { v } from "convex/values";
import { query } from "./_generated/server";

const RET = v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() });

// (a) throw-guard narrows → no NULL_BRANCH.
export const getThrow = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (!x) throw new Error("not found");
    return x;
  },
});

// (b) explicit `return null` path still needs v.null() → NULL_BRANCH fires.
export const getReturnNull = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (!x) return null;
    return x;
  },
});

// (c) non-exiting guard does NOT narrow → NULL_BRANCH fires.
export const getNoExit = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (!x) {
      console.log("missing");
    }
    return x;
  },
});

// (d) `{ ...narrowedRow }` spread is non-null (C3) → clean.
export const getSpread = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (!x) throw new Error("not found");
    return { ...x };
  },
});

// (e) `x === null` form also narrows.
export const getEqNull = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (x === null) throw new Error("not found");
    return x;
  },
});
