import { v } from "convex/values";
import type { Infer } from "convex/values";

export const changeValidator = v.union(
  v.object({
    type: v.literal("field_update"),
    field: v.string(),
    baseValue: v.any(),
    templateValue: v.any(),
    conflict: v.boolean(),
  }),
  v.object({
    type: v.literal("product_deleted"),
    productId: v.string(),
    productName: v.any(),
  }),
);

export const previewValidator = v.union(
  v.null(),
  v.object({
    changes: v.array(changeValidator),
    templateVersion: v.number(),
  }),
);
export type Preview = NonNullable<Infer<typeof previewValidator>>;

export const planValidator = v.union(
  v.object({ apply: v.literal(false), changeCount: v.number() }),
  v.object({
    apply: v.literal(true),
    changes: v.array(changeValidator),
    templateVersion: v.number(),
  }),
);
export type Plan = Infer<typeof planValidator>;
