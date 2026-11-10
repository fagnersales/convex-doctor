import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { computeChanges } from "./rules";
import type { Plan, Preview } from "./validators";

// Both helpers are annotated with Infer<> types, which hide `unknown` behind
// `any`: the value has to be traced back to computeChanges.
async function findPreview(ctx: QueryCtx, catalogId: Id<"catalogs">): Promise<Preview | null> {
  const catalog = await ctx.db.get(catalogId);
  if (!catalog) return null;
  const changes = computeChanges({ title: catalog.title }, { title: "new" });
  return { changes, templateVersion: 2 };
}

export async function buildPlan(ctx: QueryCtx, catalogId: Id<"catalogs">): Promise<Plan> {
  const preview = await findPreview(ctx, catalogId);
  if (!preview) return { apply: false, changeCount: 0 };
  return {
    apply: true,
    changes: preview.changes,
    templateVersion: preview.templateVersion,
  };
}
