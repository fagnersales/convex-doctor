# TODO

Roadmap for `convex-doctor`. Each rule maps to a class of `ReturnsValidationError` we want to catch. ✅ = shipped, 🚧 = partial, ❌ = not yet.

## Shipped — feedback overhaul + realistic patterns

- **React-doctor-style diagnostics.** `src/rules.ts` rule registry (title/category/why/fixHint/docUrl) + `makeIssue` factory; `src/report.ts` rewritten to group by category with a runtime-risk headline, per-issue _why it matters_, a copy-pasteable `fix` (synthesized from the schema shape via `shapeToValidatorSource`, ref-safe), a source excerpt with a caret on the offending field, and a docs link. `--json` is now a versioned contract (`schemaVersion`, `summary`, rich per-issue fields).
- **False-positive killers.** Null-narrowing guard pass (`if (!x) throw/return` narrows `rowOf`), `??`/`||` nullability taken from the RHS, `{ ...maybeNullRow }` treated as non-null, directional `OPTIONALITY_MISMATCH` and `STALE_FIELD` severity, opaque validator-builder branches (`doc()`) suppress hard mismatches.
- **Realistic patterns.** FK joins (`ctx.db.get(row.fkId)`), enrichment adds carrying real related-doc shapes, `ctx.storage.getUrl()` → `string | null`, direct `return result.page`, `rows.length` counts, value-bounded literals, `v.optional(v.object(...))` unwrapping, paginated-envelope keys, spread schema tables, `satisfies`, diamond shared-validator refs.
- **Robustness.** Per-function exception isolation (`ANALYZER_ERROR`) so one bad handler never crashes the run.
- **Hardened against false positives** via an adversarial review round: combined `||` null guards, narrowing propagated to alias/destructure bindings, `ctx.storage.getUrl` guards, `.filter(Boolean)` null-strips, multi-branch `.map(x => cond ? a : b)` coverage, computed string/number enrichment fields, and `v.literal(...)` fix suggestions that never silently widen a schema.
- Tests: 38 → 90, with guard fixtures locking each risky change against new false positives.

## Rules

| ID | Rule | Status | Notes |
| --- | --- | --- | --- |
| R1 | Missing schema field in row-return validator | ✅ | Original drift bug. |
| R2 | Stale field in validator (not on schema) | ✅ | warn-only — could be join. |
| R3 | Optionality mismatch (required vs optional) | ✅ | |
| R4 | Type mismatch (e.g. schema `v.string()`, validator `v.literal("x")`) | ✅ | Recursive `compareShapes` covers primitives, `id<T>`, literals, arrays, records, and union member coverage. |
| R5 | Null branch missing (`return null` not in `v.union(... v.null())`) | ✅ | |
| R6 | Cardinality (array vs single) | ✅ | |
| R7 | Paginated shape (`{ page, isDone, continueCursor }`) | ✅ | |
| R8 | Object literal missing/extra fields vs validator | ✅ | |
| R9 | `return { ...row, extra }` — schema(T) ∪ extras | ✅ | |
| R10 | `const { drop, ...rest } = row; return rest` | ✅ | Single-level destructure only. Nested rest patterns not supported. |
| R11 | Array `.map(d => ({ ...d, x }))` | ✅ | Direct + bound forms classified as `literalArray` via callback-body trace. Spread `{ ...c, extra }` inherits row origin with adds. |
| R12 | Imported validators (`returns: companyReturnValidator`) | ✅ | Local-file + relative imports + barrel re-exports (`export { x } from "./y"`). No node_modules / package imports. |
| R13 | Union return matched to handler branches by `_id` table | ✅ | |
| R14 | Discriminated union with multiple object branches | ✅ | Score-matches each handler literal to the branch whose literal-typed fields agree (e.g. `ok: true as const` → branch with `ok: v.literal(true)`). Falls back to keyset overlap. |
| R15 | Indirection (helper functions, awaited helpers) | 🚧 | `ctx.runQuery / runMutation / runAction(internal.x.y, ...)` resolves the called function's `returns` and compares to the caller's. Generic helper functions (regular fn calls) still reported as `UNANALYZED`. |

## Known false-positive sources

- **`Doc<"T">` aliases via `convex-helpers`:** `doc(schema, "stores")` returns the schema-derived shape but isn't recognized as `v.object(...)`. Treat known helpers (`doc`, `partial`, `pick`, `omit`) explicitly.
- **Args resolved in middleware:** `customQuery` / `customMutation` (convex-helpers) wrap the function. Args are typed in a different builder. Not yet recognized.
- **`ctx.runQuery` / `ctx.runMutation` / `ctx.runAction`:** Resolved — the called fn's `returns` shape is propagated. Two-pass scan; segments after `internal`/`api` map to `<filePath>:<exportName>`.
- **`Promise.all([...])`:** Resolved — passes through to argument's classification (most commonly `arr.map(...)`).
- **Conditional return paths:** ternary trace now expands both branches at the return-statement level. Nested conditionals inside non-return positions still pick `whenTrue` only (rare).

## Bugs to fix

- [x] Spread of validator `.fields` resolved — `v.object({ ...x.fields, extra })` and `{ ...plainObject }` inline correctly.
- [x] `STALE_FIELD` for synthetic `__spread:` keys suppressed.
- [x] `MISSING_FIELD` suppressed when validator has unresolved spread (might cover the field).
- [x] `const id = args.storeId; ctx.db.get(id)` — table inference now follows `idOf<T>` const-binding.
- [x] Barrel re-exports (`export { x } from "./y"`) — `findInFile` walks named export re-exports.
- [x] Nested-callback returns no longer bleed into the outer handler's intent set (e.g., `.map(c => { return ... })` inner returns).
- [x] `.map(c => ({...}))` direct return classified as `literalArray` via callback-body trace (R11).
- [x] Discriminated unions: literal returns now score-match against each branch's literal discriminator (R14).
- [x] `v.any()` validator branch short-circuits the matcher — no false NULL_BRANCH/etc.
- [x] `v.object(<identifier>)` resolves the identifier to its const definition (was emitting TYPE_MISMATCH).
- [x] Paginated synthetic no longer inherits outer `drop`/`add` set (was emitting bogus MISSING_FIELD on `page`).
- [x] Paginated literal-page override: `return { ...result, page: literalArray }` matches against validator's `page` element instead of synthesizing schema row.
- [x] Optional-chain adds: `cancelledByEmail: someUser?.email` no longer fires bogus OPTIONALITY_MISMATCH.
- [x] Multi-return `.map` callbacks (`if (skip) return null; return {...}` filtered later) prefer non-null intent — no spurious NULL_BRANCH_MISSING.
- [x] `result.page.filter(...)` / `.sort(...)` / `.slice(...)` propagate cardinality.
- [x] `Promise.all(...)` in `inferOrigin` — `const x = await Promise.all(...)` const-bindings carry the inner array origin.
- [x] Non-null assertion `foo!` unwraps to inner expression.
- [x] `ctx.db.insert("T", ...)` classified as `idValue<T>` and matched against `v.id("T")`.
- [x] `ctx.storage.generateUploadUrl()` / `ctx.storage.getUrl()` / `JSON.stringify(...)` classified as primitive `string`.
- [x] Const-bound array / primitive literals (`const arr = []`, `const x = 0`) carry their origin instead of falling to unknown.
- [ ] `ctx.db.get(someId)` where `someId` came from another row's `.someId: v.id("T")` field. Could trace via schema lookup.
- [ ] Nested `defineTable(v.object({...}))` — some Convex projects wrap the field map in `v.object(...)` explicitly. Schema parser handles bare object literal but not the wrapped form.
- [ ] `return foo.bar` where `foo` is a row binding and `bar` is a known schema field — classify as the field's primitive shape (~50 unanalyzed in spokpay).

## Nice-to-have

- [ ] `--fix` mode that injects missing fields into the validator file (best-effort, opt-in).
- [ ] `--rule R1,R5` selector to enable/disable individual rules.
- [ ] HTML/Markdown report for CI artifacts.
- [ ] Integrate with Convex codegen — read the generated `Doc<"T">` types to cross-check schema parse.
- [ ] Watch mode (`--watch`) for editor integration.
- [ ] LSP server with inline diagnostics.

## Test fixtures still needed

- [x] `validator-spread` — covers plain-object spread and `<v.object>.fields` spread.
- [x] `barrel-reexport` — `export { x } from "./y"`.
- [x] `const-binding` — `const id = args.x; ctx.db.get(id)`.
- [x] `nested-returns` — inner `.map(c => { return ... })` return doesn't leak.
- [x] `map-transform` — direct return of `.map(c => ({...}))` (R11).
- [x] `map-bound` — bound `.map` result (R11 bound case).
- [x] `discriminated-union` — `{ ok: true } | { ok: false, error }` discriminator scoring (R14).
- [x] `type-mismatch` — primitive / id-table / array-element / union-member-coverage (R4).
- [x] `ternary` — `cond ? a : b` whenFalse branch checked.
- [x] `runQuery` indirection.
- [x] `Promise.all(arr.map(...))`.
- [x] `paginated-literal-page` — `{...result, page: literalArray}` with literal validator.
- [x] `optional-add` — `someExpr?.email` add against optional validator field.
- [x] `insert-id` — `ctx.db.insert("T", ...)` matches `v.id("T")`, mismatches `v.id("U")`.
- [x] `empty-array` — `return []` early-exit doesn't trip cardinality check.
- [x] `non-null-assert` — `return foo!` unwraps to detect underlying drift.
- [x] `storage-url` — `ctx.storage.generateUploadUrl()` and `JSON.stringify(...)` as string.
- [ ] Custom builder (`customQuery` from convex-helpers) used at the call site (when needed).

## Maintenance

- [ ] Publish to npm.
- [ ] GitHub Action (`actions/setup-bun` + run check) as a starter workflow.
- [ ] Versioned changelog.
- [ ] Self-host: run the analyzer on its own fixture suite as part of `bun test`.

## Best-practice lints — deferred / coverage gaps (from the full docs audit)

Documented Convex practices NOT yet enforced, with the reason (honesty over
pretending to cover):

- [ ] `IMPLICIT_TABLE_ID` — the 6th `@convex-dev/eslint-plugin` rule (`db.get(id)`
      → `db.get("table", id)`). Completes parity, but fires on every legacy by-id
      op → highest-volume rule. Ship off-by-default / gated behind `convex>=1.31.0`.
- [ ] Search/vector index `.eq()` on a field that isn't a declared `filterField`
      — a genuine runtime footgun tsc CANNOT see. Build after schema index-name
      plumbing lands. (Highest-value beyond-tsc deferred rule.)
- [ ] `RESERVED_FIELD_NAME` / invalid-index checks (dup fields, >16 fields,
      explicit `_creationTime`) — loud deploy rejections, near-zero survival in
      committed code; value is pre-deploy/editor only.
- [ ] Same-runtime `runAction` — needs the cross-file graph resolver (R15) to
      compare `isUseNode` on both ends; mis-resolution is worse than a miss.
- [ ] ctx-param-name resolution — ctx-anchored rules hardcode `ctx`, so they
      under-report when a handler renames its first param (FP-safe, recall only).

Genuinely NOT statically decidable (deliberately omitted, never guessed):
auth/access-control on public functions (auth via arbitrary helper or unguessable
id; legit-public endpoints need none), `paginationOptsValidator` usage (style),
custom-function-wrapper team conventions, storing Date/Map/class instances in the
DB (needs the type-checker).
