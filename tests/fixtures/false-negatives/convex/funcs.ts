import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { query } from "./_generated/server";
import schema from "./schema";
import { getPointHandler } from "./handlers";

// FIX A — String()/Number()/Boolean() coercion. The handler coerces the numeric
// `sortKey` to a string, which the v.number() validator rejects at runtime.
// Previously fell through to `any` and was missed (geospatial/workpool/expo-push).
export const coerced = query({
  args: { id: v.id("points") },
  returns: v.object({
    _id: v.id("points"),
    _creationTime: v.number(),
    name: v.string(),
    sortKey: v.number(),
  }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) throw new Error("missing");
    return { ...p, sortKey: String(p.sortKey) };
  },
});

// FIX B — a named-reference handler imported from another module. The resolved
// body returns a `points` row whose `sortKey` is a number, but the validator
// declares it v.string() → drift. Previously the function was silently skipped
// (never analyzed, never reported) (aggregate/launchdarkly/rag).
export const getPointNamed = query({
  args: { id: v.id("points") },
  returns: v.object({
    _id: v.id("points"),
    _creationTime: v.number(),
    name: v.string(),
    sortKey: v.string(),
  }),
  handler: getPointHandler,
});

// FIX C — an extra field added by the handler that the validator (an unresolved
// `...schema.tables.X.validator.fields` spread) cannot possibly cover. The spread
// only contributes the table's own fields, never `bogus` → Convex rejects the
// extra field. Previously suppressed by the unresolved-spread guard (aggregate).
export const extraBehindSpread = query({
  args: { id: v.id("nodes") },
  returns: v.object({
    ...schema.tables.nodes.validator.fields,
    _id: v.id("nodes"),
    _creationTime: v.number(),
  }),
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.id);
    if (!n) throw new Error("missing");
    return { ...n, bogus: 1 };
  },
});

// FIX B guardrail — a handler genuinely wrapped in a call we can't follow
// statically must degrade to UNANALYZED (honest coverage), NOT silently vanish
// and NOT crash the run.
const wrap = (fn: any) => fn;
export const wrappedHandler = query({
  args: {},
  returns: v.object({ ok: v.boolean() }),
  handler: wrap(async () => ({ ok: true })),
});

// FIX E — a `.map()` projection used as an object-literal field. The element's
// `tag` is a number literal but the validator's element declares v.string(). The
// array element must be diffed, not flattened to `any` (expo-push id-table swap).
export const mapProjectionField = query({
  args: {},
  returns: v.object({ items: v.array(v.object({ tag: v.string() })) }),
  handler: async (ctx) => {
    const ps = await ctx.db.query("points").collect();
    return { items: ps.map((p) => ({ tag: 1 })) };
  },
});

// FIX D — convex-helpers `doc(schema, "table")` is recognized as a single-object
// validator. The handler returns an ARRAY, so it's a CARDINALITY_MISMATCH — was
// suppressed because doc() parsed as an opaque unknown branch (better-auth).
export const docCardinality = query({
  args: {},
  returns: v.union(v.null(), doc(schema, "points")),
  handler: async (ctx) => {
    return await ctx.db.query("points").collect();
  },
});

// FIX D guardrail — a single-doc return against doc(schema,"points") stays clean
// (the doc() helper must not introduce a false positive).
export const docClean = query({
  args: { id: v.id("points") },
  returns: v.union(v.null(), doc(schema, "points")),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// FIX F — `.length` is always a number; an enrichment field set to `x.length`
// is diffed against the validator instead of flattening to `any`. nameLen is a
// number but the validator declares v.string() → TYPE_MISMATCH (geospatial /
// aggregate `.map()` projections).
export const lengthField = query({
  args: { id: v.id("points") },
  returns: v.object({
    _id: v.id("points"),
    _creationTime: v.number(),
    name: v.string(),
    sortKey: v.number(),
    nameLen: v.string(),
  }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) throw new Error("missing");
    return { ...p, nameLen: p.name.length };
  },
});

// FIX G — the 2nd `.map()` callback param is the array index (a number). A field
// set to it (`idx: i`) is diffed, not flattened to `any`. idx is a number but
// the validator declares v.string() → TYPE_MISMATCH (expo-push `id: idx`).
export const mapIndexField = query({
  args: {},
  returns: v.array(v.object({ name: v.string(), idx: v.string() })),
  handler: async (ctx) => {
    const ps = await ctx.db.query("points").collect();
    return ps.map((p, i) => ({ name: p.name, idx: i }));
  },
});

// id-vs-string compat — an Id is a string at runtime, so a handler returning a
// row whose `_id` is id<points> satisfies a validator that declares `_id`
// v.string(). Must stay CLEAN (workflow component validates `_id` as v.string()).
export const rowIdAsString = query({
  args: { id: v.id("points") },
  returns: v.object({
    _id: v.string(),
    _creationTime: v.number(),
    name: v.string(),
    sortKey: v.number(),
  }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.id);
    if (!p) throw new Error("missing");
    return p;
  },
});
