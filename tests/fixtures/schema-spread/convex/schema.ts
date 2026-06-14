import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { sharedTables } from "./tables";

export default defineSchema({
  ...sharedTables,
  stores: defineTable({ name: v.string() }),
});
