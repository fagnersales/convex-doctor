import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  posts: defineTable({ authorId: v.id("users"), title: v.string() }),
  users: defineTable({ name: v.string(), secret: v.string() }),
});
