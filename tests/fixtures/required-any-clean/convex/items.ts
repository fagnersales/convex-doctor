import { v } from "convex/values";
import { query } from "./_generated/server";

type Change = { field: string; value: unknown };

function compute(): Change[] {
  return [{ field: "title", value: undefined }];
}

function label(): string {
  return "label";
}

// Always set to a concrete type: nothing to report.
export const concrete = query({
  args: {},
  returns: v.array(v.object({ name: v.string(), value: v.any() })),
  handler: async () => {
    const names = ["a", "b"];
    return names.map((name) => ({ name, value: label() }));
  },
});

// Already wrapped in v.optional(v.any()): `unknown` is fine there.
export const wrapped = query({
  args: {},
  returns: v.array(v.object({ field: v.string(), value: v.optional(v.any()) })),
  handler: async () => {
    return compute();
  },
});

// A top-level `undefined` return becomes `null`, which v.any() accepts.
export const topLevel = query({
  args: {},
  returns: v.any(),
  handler: async () => {
    const c: unknown = undefined;
    return c;
  },
});
