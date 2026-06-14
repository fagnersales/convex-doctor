import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  stores: defineTable({ name: v.string() }),
});
export default schema;
