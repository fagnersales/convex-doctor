import { v } from "convex/values";
import { query } from "./_generated/server";
import { noteValidator } from "./validators";

// Optionality lives inside the referenced const, not in a syntactic
// v.optional(...) at the field site — must NOT flag OPTIONALITY_MISMATCH.
const metadataValidator = v.optional(
  v.object({
    modelId: v.optional(v.string()),
    totalTokens: v.optional(v.number()),
  }),
);

export const getTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.union(
    v.object({
      _id: v.id("tasks"),
      _creationTime: v.number(),
      name: v.string(),
      metadata: metadataValidator,
      note: noteValidator,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.taskId);
  },
});
