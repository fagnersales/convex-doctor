import { query } from "./_generated/server";
import { v } from "convex/values";

// handler returns `{ count, total }` — validator missing `total`
export const stats = query({
  args: {},
  returns: v.object({
    count: v.number(),
  }),
  handler: async () => {
    return { count: 1, total: 5 };
  },
});

// handler omits required `total` (validator says required, handler doesn't include)
export const partialStats = query({
  args: {},
  returns: v.object({
    count: v.number(),
    total: v.number(),
  }),
  handler: async () => {
    return { count: 1 };
  },
});
