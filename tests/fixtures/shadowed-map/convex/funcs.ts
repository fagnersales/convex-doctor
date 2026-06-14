import { v } from "convex/values";
import { query } from "./_generated/server";

// Variable-shadowing regression (get-convex/presence `list`/`listRoom`/`listUser`).
// The OUTER `const online` is a rows<T> array; the `.map` callback destructures a
// row field ALSO named `online` (a boolean). The returned shorthand `online` must
// resolve to the destructured boolean field — NOT the outer array — so this is
// CLEAN. Before the fix the analyzer bound `online` to the outer array and emitted
// a spurious `TYPE_MISMATCH` ("expected array, validator has boolean").
export const shadowMap = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.string(),
      online: v.boolean(),
      lastDisconnected: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const online = await ctx.db.query("presence").collect();
    return online.map(({ userId, online, lastDisconnected }) => ({
      userId,
      online,
      lastDisconnected,
    }));
  },
});

// The exact presence shape: `results` is a spread of two rows<T> arrays (so the
// element origin is NOT a known row — the destructured names bind opaque). The
// shadowing fix must still suppress the `online` FP here even without schema
// knowledge of the element.
export const shadowSpread = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.string(),
      online: v.boolean(),
      lastDisconnected: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const online = await ctx.db.query("presence").collect();
    const offline = await ctx.db.query("presence").collect();
    const results = [...online, ...offline];
    return results.map(({ userId, online, lastDisconnected }) => ({
      userId,
      online,
      lastDisconnected,
    }));
  },
});

// Guardrail: the shadowing fix must NOT blanket-suppress real drift. Here the
// `.map` destructures-and-renames (`_id: id`) over a known rows<T>, and the
// schema column `count` is a number while the validator declares `v.string()`.
// The field still resolves to its schema column shape → TYPE_MISMATCH must fire.
export const shadowDrift = query({
  args: {},
  returns: v.array(v.object({ id: v.id("widgets"), count: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("widgets").collect();
    return rows.map(({ _id: id, count }) => ({ id, count }));
  },
});
