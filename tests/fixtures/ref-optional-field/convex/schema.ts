import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tasks: defineTable({
    name: v.string(),
    metadata: v.optional(
      v.object({
        modelId: v.optional(v.string()),
        totalTokens: v.optional(v.number()),
      }),
    ),
    note: v.optional(v.string()),
  }),
});
