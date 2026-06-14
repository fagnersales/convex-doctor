import { v } from "convex/values";
import { query } from "./_generated/server";

// Wrong literal value → mismatch.
export const statusBad = query({
  args: {},
  returns: v.literal("active"),
  handler: async (ctx) => "inactive",
});

// Right literal value → clean.
export const statusOk = query({
  args: {},
  returns: v.literal("active"),
  handler: async (ctx) => "active",
});

// Any string vs v.string() → clean.
export const statusStr = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => "whatever",
});
