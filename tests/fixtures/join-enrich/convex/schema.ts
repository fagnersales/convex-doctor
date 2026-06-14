import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  teams: defineTable({ name: v.string() }),
  users: defineTable({ name: v.string(), email: v.string() }),
});
