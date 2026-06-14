import { v } from "convex/values";
import { query } from "./_generated/server";

// Validator omits users.secret — drift on the joined row.
export const getAuthor = query({
  args: { postId: v.id("posts") },
  returns: v.union(
    v.object({ _id: v.id("users"), _creationTime: v.number(), name: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (!post) throw new Error("no post");
    return await ctx.db.get(post.authorId);
  },
});
