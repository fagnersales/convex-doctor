import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  catalogs: defineTable({ title: v.string() }),
});
