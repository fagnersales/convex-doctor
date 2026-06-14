import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  stores: defineTable({ req: v.string(), opt: v.optional(v.string()) }),
});
