# TODO

Roadmap for `check-convex-validators`. Each rule maps to a class of `ReturnsValidationError` we want to catch. ✅ = shipped, 🚧 = partial, ❌ = not yet.

## Rules

| ID | Rule | Status | Notes |
| --- | --- | --- | --- |
| R1 | Missing schema field in row-return validator | ✅ | Original drift bug. |
| R2 | Stale field in validator (not on schema) | ✅ | warn-only — could be join. |
| R3 | Optionality mismatch (required vs optional) | ✅ | |
| R4 | Type mismatch (e.g. schema `v.string()`, validator `v.literal("x")`) | ❌ | Currently only checks presence/optionality. Needs recursive structural compare. |
| R5 | Null branch missing (`return null` not in `v.union(... v.null())`) | ✅ | |
| R6 | Cardinality (array vs single) | ✅ | |
| R7 | Paginated shape (`{ page, isDone, continueCursor }`) | ✅ | |
| R8 | Object literal missing/extra fields vs validator | ✅ | |
| R9 | `return { ...row, extra }` — schema(T) ∪ extras | ✅ | |
| R10 | `const { drop, ...rest } = row; return rest` | ✅ | Single-level destructure only. Nested rest patterns not supported. |
| R11 | Array `.map(d => ({ ...d, x }))` | 🚧 | `.map()` cardinality preserved, but the closure body's spread+add isn't traced through. |
| R12 | Imported validators (`returns: companyReturnValidator`) | ✅ | Local-file + relative imports. No node_modules / package imports. |
| R13 | Union return matched to handler branches by `_id` table | ✅ | |
| R14 | Discriminated union with multiple object branches | 🚧 | Currently picks first matching branch. Need to score-match by `_id` and shape. |
| R15 | Indirection (helper functions, awaited helpers) | ✅ | Reported as `UNANALYZED` (info; opt-in). |

## Known false-positive sources

- **Validator spread:** `v.object({ ...someValidator.fields, extra: v.string() })` — current parser records `__spread:foo.fields` as a synthetic key and emits `STALE_FIELD`. Need to resolve `<symbol>.fields` (property access on `v.object(...)` validators) and inline its field map. **Common in real codebases.** Highest-priority fix.
- **`Doc<"T">` aliases via `convex-helpers`:** `doc(schema, "stores")` returns the schema-derived shape but isn't recognized as `v.object(...)`. Treat known helpers (`doc`, `partial`, `pick`, `omit`) explicitly.
- **External base validators:** `companyReturnValidator` re-exported through a barrel (`./validators/index.ts`) where the symbol redirects via `export { x } from "./y"`. Symbol resolver currently follows direct imports only.
- **Args resolved in middleware:** `customQuery` / `customMutation` (convex-helpers) wrap the function. Args are typed in a different builder. Not yet recognized.
- **`ctx.runQuery` / `ctx.runMutation`:** When a handler returns the result of an internal call, we mark it `unanalyzed`. Could resolve the called function's `returns` shape and propagate.
- **`Promise.all([...])`:** array of awaited rows. `.map(...)` chained. Trace through.
- **Conditional return paths:** ternary trace currently follows the `whenTrue` branch only. Need both branches → emit one intent per branch.

## Bugs to fix

- [ ] Spread of validator `.fields` not resolved (see false-positive list).
- [ ] `STALE_FIELD` for synthetic `__spread:` keys is noise — suppress when we can't resolve, or hide unless `--strict`.
- [ ] When `argsShape` exists but the arg is reassigned (`const id = args.storeId; ctx.db.get(id);`), table inference fails. Need light const-binding tracking.
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

- [ ] `validator-spread-fields` — currently a false-positive source.
- [ ] `runQuery` indirection.
- [ ] Custom builder (`customQuery` from convex-helpers).
- [ ] Discriminated union return (e.g. `v.union(v.object({_id: v.id("a")...}), v.object({_id: v.id("b")...}))`).
- [ ] Conditional ternary returning row vs null.

## Maintenance

- [ ] Publish to npm.
- [ ] GitHub Action (`actions/setup-bun` + run check) as a starter workflow.
- [ ] Versioned changelog.
- [ ] Self-host: run the analyzer on its own fixture suite as part of `bun test`.
