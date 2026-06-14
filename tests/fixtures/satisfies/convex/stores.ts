import { v, type Validator } from "convex/values";
import { query } from "./_generated/server";

// `satisfies` is unwrapped like `as` → drift (missing secret) still detected.
export const getStore = query({
  args: { id: v.id("stores") },
  returns: (v.union(
    v.object({ _id: v.id("stores"), _creationTime: v.number(), name: v.string() }),
    v.null(),
  ) satisfies Validator<any, "required", any>),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
