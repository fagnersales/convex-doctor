import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  stores: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    isActive: v.boolean(),
    cachedAvailableBalance: v.optional(v.number()),
  }),
  users: defineTable({
    email: v.string(),
  }),
});
