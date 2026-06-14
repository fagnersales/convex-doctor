import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { query } from "./_generated/server";
import schema from "./schema";

// doc(schema,"stores") is an opaque validator-builder — must NOT produce a
// hard TYPE_MISMATCH just because we can't introspect it (C6).
export const getStore = query({
  args: { id: v.id("stores") },
  returns: v.union(doc(schema, "stores"), v.null()),
  handler: async (ctx, args) => ctx.db.get(args.id),
});
