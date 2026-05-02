import { v } from "convex/values";
import { query } from "./_generated/server";
import { companyReturnValidator } from "./validators";

export const getCompany = query({
  args: { companyId: v.id("companies") },
  returns: v.union(companyReturnValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.companyId);
  },
});
