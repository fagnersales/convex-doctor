import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildPlan } from "./core";
import { computeChanges } from "./rules";
import { changeValidator, planValidator } from "./validators";

// Reproduces the SpokPay rebase crash: changes[].baseValue / templateValue are
// `unknown` and can be undefined → ReturnsValidationError.
export const plan = internalQuery({
  args: { catalogId: v.id("catalogs") },
  returns: planValidator,
  handler: async (ctx, args) => {
    return await buildPlan(ctx, args.catalogId);
  },
});

export const apply = internalMutation({
  args: { changes: v.array(changeValidator) },
  returns: v.null(),
  handler: async () => {
    return null;
  },
});

// Args side: the caller passes `unknown` values straight into apply's required
// v.any() fields.
export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.plans.apply, {
      changes: computeChanges({}, { title: "x" }),
    });
    return null;
  },
});

type Settings = { label?: string; extra: string | undefined };

// An optional property (`label?:`) and a `T | undefined` both reach a
// required v.any().
export const settings = query({
  args: {},
  returns: v.object({ label: v.any(), extra: v.any() }),
  handler: async () => {
    const s: Settings = { extra: undefined };
    return { label: s.label, extra: s.extra };
  },
});

// An explicit `any` proves nothing either way → warning, not error.
export const parsed = query({
  args: { raw: v.string() },
  returns: v.object({ payload: v.any() }),
  handler: async (_ctx, args) => {
    const payload = JSON.parse(args.raw);
    return { payload };
  },
});
