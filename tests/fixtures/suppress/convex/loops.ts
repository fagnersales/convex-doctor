import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

// Suppressed via a comment on the line ABOVE the flagged await.
export const suppressedAbove = mutation({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      // convex-doctor: ignore AWAIT_IN_LOOP — sequential by design (read-your-writes dedupe)
      await ctx.db.delete(id);
    }
    return null;
  },
});

// Suppressed via a TRAILING comment on the flagged line itself.
export const suppressedTrailing = query({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, args) => {
    let total = 0;
    for (const id of args.ids) {
      const item = await ctx.db.get(id); // convex-doctor: ignore AWAIT_IN_LOOP — order matters
      if (item) total += item.basePrice;
    }
    return total;
  },
});

// Comment names a DIFFERENT code — the AWAIT_IN_LOOP finding must survive.
export const wrongCode = query({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, args) => {
    let total = 0;
    for (const id of args.ids) {
      // convex-doctor: ignore FILTER_IN_QUERY — does not cover this finding
      const item = await ctx.db.get(id);
      if (item) total += item.basePrice;
    }
    return total;
  },
});

// Several codes in one directive, lowercase — both findings on this line go.
export const multiCode = query({
  args: {},
  handler: async (ctx) => {
    // convex-doctor: ignore unbounded_collect, filter_in_query — legacy table, tiny
    const rows = await ctx.db.query("items").filter((q) => q.eq(q.field("name"), "x")).collect();
    return rows.length;
  },
});

// No directive anywhere — stays flagged (control).
export const notSuppressed = query({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, args) => {
    let total = 0;
    for (const id of args.ids) {
      const item = await ctx.db.get(id);
      if (item) total += item.basePrice;
    }
    return total;
  },
});
