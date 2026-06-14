import { v } from "convex/values";
import { query } from "./_generated/server";

// `.map(x => cond ? a : b)` — BOTH element branches are diffed (B11). The else
// branch drifts: extra `oops`, missing `label`.
export const mapTernary = query({
  args: {},
  returns: v.array(v.object({ name: v.string(), label: v.string() })),
  handler: async (ctx) => {
    const all = await ctx.db.query("users").collect();
    return all.map((u) =>
      u.name === "x" ? { name: u.name, label: "a" } : { name: u.name, oops: 1 },
    );
  },
});

// Fan-out join cleaned with `.filter(d => d !== null)` → element is non-null,
// so v.array(<row>) (no v.null()) is correct → clean.
export const fanout = query({
  args: { ids: v.array(v.id("users")) },
  returns: v.array(
    v.object({
      _id: v.id("users"),
      _creationTime: v.number(),
      name: v.string(),
      first: v.string(),
      last: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter((d) => d !== null);
  },
});

// Computed string-concat enrichment field vs v.number() → TYPE_MISMATCH.
export const enrich = query({
  args: { id: v.id("users") },
  returns: v.object({
    _id: v.id("users"),
    _creationTime: v.number(),
    name: v.string(),
    first: v.string(),
    last: v.string(),
    fullName: v.number(),
  }),
  handler: async (ctx, args) => {
    const u = await ctx.db.get(args.id);
    if (!u) throw new Error("missing");
    return { ...u, fullName: u.first + " " + u.last };
  },
});
