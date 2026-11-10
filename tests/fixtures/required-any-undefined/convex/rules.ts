export type Change =
  | {
      type: "field_update";
      field: string;
      baseValue: unknown;
      templateValue: unknown;
      conflict: boolean;
    }
  | {
      type: "product_deleted";
      productId: string;
      productName: string;
    };

const FIELDS = ["title", "category"] as const;

export function computeChanges(
  base: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Change[] {
  const changes: Change[] = [];
  for (const field of FIELDS) {
    const baseValue = base[field];
    const templateValue = theirs[field];
    if (baseValue !== templateValue) {
      changes.push({ type: "field_update", field, baseValue, templateValue, conflict: false });
    }
  }
  return changes;
}
