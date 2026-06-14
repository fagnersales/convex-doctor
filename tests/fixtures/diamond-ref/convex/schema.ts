import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  routes: defineTable({
    start: v.object({ lat: v.number(), lng: v.number() }),
    end: v.object({ lat: v.number(), lng: v.number() }),
  }),
});
