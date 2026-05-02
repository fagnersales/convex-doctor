import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  stores: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    isActive: v.boolean(),
    description: v.optional(v.string()),
  }),
  users: defineTable({
    email: v.string(),
  }),
});
