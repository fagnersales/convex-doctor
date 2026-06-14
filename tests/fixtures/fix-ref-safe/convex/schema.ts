import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { externalBlob } from "convex-helpers/blob";

export default defineSchema({
  stores: defineTable({ name: v.string(), blob: externalBlob }),
});
