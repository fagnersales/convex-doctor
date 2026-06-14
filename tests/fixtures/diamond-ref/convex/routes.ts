import { v } from "convex/values";
import { query } from "./_generated/server";
import { coords } from "./validators";

export const getRoute = query({
  args: { id: v.id("routes") },
  returns: v.union(
    v.object({ _id: v.id("routes"), _creationTime: v.number(), start: coords, end: coords }),
    v.null(),
  ),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
