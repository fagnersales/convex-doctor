import { v } from "convex/values";
import { query } from "./_generated/server";

// The .map callback inside Promise.all builds `{ name, url }`, but the
// validator declares `{ name, label }`. Without Promise.all tracing this
// is unanalyzed and the drift is missed.
export const projectedAsync = query({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      label: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    return await Promise.all(
      items.map(async (item) => ({
        name: item.name,
        url: "https://example.com/" + item.storageId,
      })),
    );
  },
});
