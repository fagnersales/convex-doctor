import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Mirrors get-convex/presence: `online` is a boolean column.
  presence: defineTable({
    userId: v.string(),
    online: v.boolean(),
    lastDisconnected: v.number(),
  }),
  widgets: defineTable({ count: v.number(), label: v.string() }),
});
