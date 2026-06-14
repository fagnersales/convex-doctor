import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// The spokpay `seedGamepassCustom` pattern: a nullable runQuery result is
// returned only inside an `if (existing)` block, so `existing` is provably
// non-null there. The validator `catalogId: v.string()` is correct and must
// NOT be flagged (positive-guard narrowing in the consequent).
export const seedGuarded = internalAction({
  args: {},
  returns: v.object({
    catalogId: v.string(),
    alreadySeeded: v.boolean(),
  }),
  handler: async (ctx) => {
    const existing = await ctx.runQuery(internal.helpers.findCatalog, {});
    if (existing) {
      return { catalogId: existing, alreadySeeded: true };
    }
    const created = await ctx.runMutation(internal.helpers.makeCatalog, {});
    return { catalogId: created, alreadySeeded: false };
  },
});

// `if (existing !== null)` form also narrows the consequent.
export const seedGuardedNeqNull = internalAction({
  args: {},
  returns: v.object({ catalogId: v.string() }),
  handler: async (ctx) => {
    const existing = await ctx.runQuery(internal.helpers.findCatalog, {});
    if (existing !== null) {
      return { catalogId: existing };
    }
    const created = await ctx.runMutation(internal.helpers.makeCatalog, {});
    return { catalogId: created };
  },
});

// Soundness: an UNGUARDED return of the nullable value must STILL be flagged —
// the fix must not blanket-suppress nullability.
export const seedUnguarded = internalAction({
  args: {},
  returns: v.object({ catalogId: v.string() }),
  handler: async (ctx) => {
    const existing = await ctx.runQuery(internal.helpers.findCatalog, {});
    return { catalogId: existing };
  },
});
