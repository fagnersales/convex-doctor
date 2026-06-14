import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sharedTables = {
  audit: defineTable({ action: v.string(), secret: v.string() }),
};
