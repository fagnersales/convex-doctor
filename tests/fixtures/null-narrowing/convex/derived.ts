import { v } from "convex/values";
import { query } from "./_generated/server";

const RET = v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() });

// Combined `||` guard narrows the row (fall-through is `!x && ...`) → clean.
export const getCombined = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (!x || x.name === "") throw new Error("bad");
    return x;
  },
});

// Narrowing reaches a plain alias of the guarded var → clean.
export const getAlias = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const u = await ctx.db.get(args.id);
    if (!u) throw new Error("missing");
    const u2 = u;
    return u2;
  },
});

// Narrowing reaches a destructure-rest of the guarded var → clean.
export const getRest = query({
  args: { id: v.id("stores") },
  returns: v.object({ _id: v.id("stores"), _creationTime: v.number() }),
  handler: async (ctx, args) => {
    const u = await ctx.db.get(args.id);
    if (!u) throw new Error("missing");
    const { name, ...rest } = u;
    return rest;
  },
});

// `if (x === undefined) throw` does NOT narrow a db.get row (it's T|null, never
// undefined) → NULL_BRANCH still fires (soundness, no false confidence).
export const getStrictUndef = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const x = await ctx.db.get(args.id);
    if (x === undefined) throw new Error("missing");
    return x;
  },
});

// Unguarded `{ ...maybeNull }` — on the null path collapses to `{}` → flagged.
export const getUnguardedSpread = query({
  args: { id: v.id("stores") },
  returns: RET,
  handler: async (ctx, args) => {
    const u = await ctx.db.get(args.id);
    return { ...u };
  },
});
