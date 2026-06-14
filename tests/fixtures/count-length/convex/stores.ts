import { v } from "convex/values";
import { query } from "./_generated/server";

// `.length` is a number — validator v.array(...) is wrong cardinality.
export const countBad = query({
  args: {},
  returns: v.array(v.id("stores")),
  handler: async (ctx) => {
    const all = await ctx.db.query("stores").collect();
    return all.length;
  },
});

export const countOk = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const all = await ctx.db.query("stores").collect();
    return all.length;
  },
});
