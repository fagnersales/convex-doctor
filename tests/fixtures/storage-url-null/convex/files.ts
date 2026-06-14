import { v } from "convex/values";
import { query } from "./_generated/server";

// getUrl is string|null — validator v.string() omits the null case → drift.
export const urlBad = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => await ctx.storage.getUrl(args.id),
});

// validator allows null → clean.
export const urlOk = query({
  args: { id: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => await ctx.storage.getUrl(args.id),
});

// `?? ""` strips the null → clean against v.string().
export const urlFallback = query({
  args: { id: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => (await ctx.storage.getUrl(args.id)) ?? "",
});

// An early-exit null guard narrows the url binding → clean against v.string().
export const urlGuard = query({
  args: { id: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.id);
    if (!url) throw new Error("no url");
    return { url };
  },
});
