import { v } from "convex/values";
import { query } from "./_generated/server";

const MEMBER = v.object({ _id: v.id("users"), _creationTime: v.number(), name: v.string(), email: v.string() });

// Nested validator correct → clean.
export const getTeamOk = query({
  args: { id: v.id("teams") },
  returns: v.object({ _id: v.id("teams"), _creationTime: v.number(), name: v.string(), members: v.array(MEMBER) }),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.id);
    if (!team) throw new Error("no team");
    const members = await ctx.db.query("users").collect();
    return { ...team, members };
  },
});

// Nested validator drops users.email → drift on `members`.
export const getTeamDrift = query({
  args: { id: v.id("teams") },
  returns: v.object({
    _id: v.id("teams"), _creationTime: v.number(), name: v.string(),
    members: v.array(v.object({ _id: v.id("users"), _creationTime: v.number(), name: v.string() })),
  }),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.id);
    if (!team) throw new Error("no team");
    const members = await ctx.db.query("users").collect();
    return { ...team, members };
  },
});
