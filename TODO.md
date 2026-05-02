# TODO

Roadmap for `check-convex-validators`. Each rule maps to a class of `ReturnsValidationError` we want to catch. ✅ = shipped, 🚧 = partial, ❌ = not yet.

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
- [ ] `ctx.db.get(someId)` where `someId` came from another row's `.someId: v.id("T")` field. Could trace via schema lookup.
- [ ] Nested `defineTable(v.object({...}))` — some Convex projects wrap the field map in `v.object(...)` explicitly. Schema parser handles bare object literal but not the wrapped form.

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
- [ ] Custom builder (`customQuery` from convex-helpers).

## Maintenance

- [ ] Publish to npm.
- [ ] GitHub Action (`actions/setup-bun` + run check) as a starter workflow.
- [ ] Versioned changelog.
- [ ] Self-host: run the analyzer on its own fixture suite as part of `bun test`.
