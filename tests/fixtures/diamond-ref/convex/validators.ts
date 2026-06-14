import { v } from "convex/values";
// lat is wrong (string, schema says number) — drift must surface on BOTH
// fields that reference this shared validator, not just the first (C9).
export const coords = v.object({ lat: v.string(), lng: v.number() });
