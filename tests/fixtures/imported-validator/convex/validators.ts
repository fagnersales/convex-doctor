import { v } from "convex/values";

// drifted: schema added `cachedBalance`, validator wasn't updated
export const companyReturnValidator = v.object({
  _id: v.id("companies"),
  _creationTime: v.number(),
  name: v.string(),
  description: v.optional(v.string()),
});
