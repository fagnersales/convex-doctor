import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

// Returns an existing catalog id, or null when none exists yet.
export const findCatalog = internalQuery({
  args: {},
  returns: v.union(v.id("catalogs"), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("catalogs").first();
    return row ? row._id : null;
  },
});

// Always returns a freshly-inserted (non-null) id.
export const makeCatalog = internalMutation({
  args: {},
  returns: v.id("catalogs"),
  handler: async (ctx) => {
    return await ctx.db.insert("catalogs", { title: "x" });
  },
});
