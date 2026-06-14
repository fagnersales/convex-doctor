# convex-doctor

Static analyzer for Convex codebases — _before_ deploy. Two layers in one pass, emitted as plain text or JSON with file/line for fast triage:

1. **Returns-validator drift** — the `returns` validator on a query/mutation drifts away from the schema, the handler return shape, or both, so it passes typecheck but throws `ReturnsValidationError` at runtime when a real row is returned.
2. **Best-practice lints** — the Convex anti-patterns (`await` in a loop, `.filter` on a query, unbounded `.collect`, nondeterministic queries, missing arg validators, …), including the rules the official `@convex-dev/eslint-plugin` ships. These fire on _any_ Convex code, whether or not the project uses `returns` validators, and run by default — no ESLint install or config required (`--no-lint` to skip).

It walks `convex/schema.ts` + every `query | mutation | action | internal*` definition, infers what each handler can return, compares that against the declared `returns` validator, and lints each handler body.

## Quick start

Published as the scoped package [`@fagnersales/convex-doctor`](https://www.npmjs.com/package/@fagnersales/convex-doctor). It runs on [Bun](https://bun.sh) (the CLI executes TypeScript directly).

```bash
# inside any Convex project
bunx @fagnersales/convex-doctor

# scan a non-default convex dir
bunx @fagnersales/convex-doctor --convex-dir backend/convex

# wire into your typecheck step
"typecheck": "tsgo --noEmit && bunx @fagnersales/convex-doctor"
```

## What it detects

| Code | Severity | Description |
| --- | --- | --- |
| `MISSING_FIELD` | error | Schema has a field; the row-return validator omits it (the original drift bug). |
| `STALE_FIELD` | error / info | Validator lists a field schema doesn't have. **error** when the field is required (provably throws); **info** when optional (dead weight). |
| `OPTIONALITY_MISMATCH` | error | Schema field is optional but the validator requires it (directional — schema-required + validator-optional never throws, so it is _not_ flagged). |
| `NULL_BRANCH_MISSING` | error | Handler can return `null` (e.g. `.first()` / `.unique()` / `ctx.db.get`) but validator lacks `v.null()`. Suppressed when an early-exit null guard (`if (!x) throw/return`) narrows the value. |
| `CARDINALITY_MISMATCH` | error | `.collect()` returns array but validator is single object (and vice versa). |
| `EXTRA_LITERAL_FIELD` | error | Handler literal returns a field the validator doesn't declare. |
| `MISSING_LITERAL_FIELD` | error | Validator requires a field the handler literal never sets. |
| `TYPE_MISMATCH` | error | Type categories disagree (primitive vs object, wrong `id<T>` table, wrong array element, value-bounded literal, joined/enriched field shape, paginated envelope type, …). |
| `UNANALYZED` | info | Handler return is too dynamic to trace (helper call, multi-spread, etc.). Off by default — use `--include-unanalyzed`. |
| `ANALYZER_ERROR` | error | The analyzer itself threw on one function — that function is skipped, the rest of the run is unaffected. |

Every diagnostic is rendered with a plain-language **why it matters**, a concrete **fix** (often a copy-pasteable `v.*` snippet), a source excerpt with a caret on the offending field, and a Convex docs link. Output is grouped by category with a headline summarizing how many functions will throw `ReturnsValidationError` at runtime. Add `--json` for a versioned, CI-friendly contract (`schemaVersion`, `summary`, and the rich per-issue fields).

## Best-practice lints

Run by default alongside the drift checks (`--no-lint` to disable). They encode the [Convex best-practices guide](https://docs.convex.dev/understanding/best-practices/) plus the rules from the official [`@convex-dev/eslint-plugin`](https://docs.convex.dev/eslint), so you get the whole sweep from one CLI without installing or configuring ESLint.

| Code | Severity | Description |
| --- | --- | --- |
| `AWAIT_IN_LOOP` | warn / info | `await ctx.db.*` / `ctx.runQuery` inside a `for`/`for-of` loop — sequential round-trips to parallelize with `Promise.all`. **warn** for reads; **info** for writes (parallel writes to the same doc can conflict). Loop-carried accumulators and pagination cursors are not flagged. |
| `FILTER_IN_QUERY` | warn | `.filter()` on a `ctx.db.query(...)` chain — scans the table; use `.withIndex` or filter in plain TypeScript. (JS array `.filter`, and the documented `.paginate()` exception, are not flagged.) |
| `UNBOUNDED_COLLECT` | warn | `.collect()` on a query with no index narrowing — can load the whole table. Bound with `.withIndex`, `.take(n)`, or `.paginate()`. |
| `NONDETERMINISTIC_QUERY` | warn | `Date.now()` / `Math.random()` / `new Date()` inside a **query** — breaks the reactive cache (the value never updates with wall-clock time). Allowed in mutations/actions. |
| `SEQUENTIAL_CTX_RUN` | info | Multiple `await ctx.runMutation(...)` in one action — each is a separate transaction; consolidate for atomicity. |
| `MISSING_ARG_VALIDATOR` | warn / info | A function with no `args` validator. **warn** for public functions (client input reaches the handler unchecked); **info** for `internal*`. |
| `OLD_FUNCTION_SYNTAX` | warn | `query(fn)` instead of `query({ handler })` — the bare-function form can't carry `args`/`returns` validators. |
| `SCHEDULE_PUBLIC_FN` | warn | `ctx.scheduler` / `ctx.runX` referencing a public `api.*` function — the Convex guide says to ensure these use `internal.*`, since a public function is reachable by any client (security). |
| `WRONG_RUNTIME_IMPORT` | warn | A default-runtime (V8) file importing from a `"use node"` module — the Node code can't load in Convex's V8 isolate. |
| `FLOATING_CTX_PROMISE` | warn | A promise-returning `ctx.*` call (write/schedule/run) left un-awaited at statement position — it may never run and errors are swallowed. |
| `FETCH_IN_QUERY` | error | `fetch()` inside a query/mutation — the V8 isolate has no `fetch`; it throws. Belongs in an action. |
| `DB_IN_ACTION` | error | `ctx.db` used in an action — `ActionCtx` has no `db`; use `ctx.runQuery` / `ctx.runMutation`. |
| `QUERY_IN_NODE_FILE` | error | A query/mutation in a `"use node"` file — can't run in Node; deploy is rejected. |
| `NODE_BUILTIN_WITHOUT_USE_NODE` | warn | A Node builtin (`node:fs`, `path`, …) imported in a file with no `"use node"`. |
| `MISPLACED_USE_NODE` | warn | A `"use node"` directive not at the top of the file — silently ignored by the bundler. |
| `CRON_PUBLIC_FN` | warn | A cron job scheduling a public `api.*` function (the "check crons.ts" half of `SCHEDULE_PUBLIC_FN`). |
| `DUPLICATE_CRON_ID` | error | Two cron jobs registered with the same identifier — Convex rejects the deploy. |
| `CTX_RUN_IN_QUERY_OR_MUTATION` | info | `ctx.runQuery` / `ctx.runMutation` inside a query/mutation — overhead with no benefit; use a plain helper. (Components are exempted.) |
| `REDUNDANT_INDEX` | warn | A schema index whose fields are a prefix of another index on the same table (`by_a` when `by_a_b` exists). |
| `SCHEMA_VALIDATION_DISABLED` | info | `defineSchema(..., { schemaValidation: false })` — schema is no longer enforced at runtime. |

Each rule deep-links to the exact Convex doc section it enforces. Documented practices that are *not* statically decidable (auth checks on public functions, same-runtime `runAction`) are deliberately left out rather than guessed at — see `TODO.md`.

### Realistic patterns it understands

Foreign-key joins (`ctx.db.get(row.fkId)`), enrichment spreads (`{ ...row, related }` with the related doc/array diffed against the nested validator), `ctx.storage.getUrl()` as `string | null`, direct `return result.page`, count queries (`rows.length`), value-bounded literals (`return "active"` vs `v.literal(...)`), `v.optional(v.object(...))` returns, the paginated envelope (`isDone` / `continueCursor`), spread schema tables (`...sharedTables`), `satisfies Validator<…>`, and shared validators referenced by multiple fields.

## How it works

1. **Schema parse** — `defineSchema({ T: defineTable({...}) })` → field map per table.
2. **Function walk** — every exported `query/mutation/action/internal*` call. Captures `args`, `returns`, and `handler`.
3. **Validator parse** — `v.object/array/union/optional/null/literal/id/...` → recursive `Shape` ADT. Resolves cross-file `import { fooValidator } from "./validators"`.
4. **Handler analysis** — traces every `return` statement to one of:
    - `row<T>` (`ctx.db.get(args.id)`, `.first()`, `.unique()`)
    - `rows<T>` (`.collect()`, `.take()`)
    - `paginated<T>` (`.paginate()`)
    - object literal (with optional spread + drops + adds)
    - `null`, primitive, or `unanalyzed`
5. **Matcher** — pairs each return path with the right branch of the (possibly union) `returns` validator and emits diff issues.

## Dead-function detection

Optional. `--dead` builds a call graph across the project — resolving `api.*` / `internal.*` chains through barrel re-exports — and lists every Convex function no caller reaches. Use `--dead-only` to print just the list, `--ignore-dead <pattern>` to exclude known entry points (`*` wildcard, repeatable), and `--project-root <path>` to widen the caller scan beyond the parent of `--convex-dir`.

```bash
bunx @fagnersales/convex-doctor --convex-dir convex --dead-only --ignore-dead 'migrations:*'
```

## CLI

```
--convex-dir <path>      Path to convex/ directory. Default: convex
--schema <path>          Path to schema.ts. Default: <convex-dir>/schema.ts
--include-unanalyzed     Print INFO entries for unanalyzed handlers
--json                   Emit JSON instead of text
--strict                 Exit nonzero if any warnings are present
--no-lint                Skip the best-practice lints (drift checks only)
--dead                   Print the dead-function list after the regular report
--dead-only              Print only the dead list (or dead+ignored under --json)
--ignore-dead <pattern>  Glob (`*` wildcard) excluding nodes from the dead list. Repeatable
--project-root <path>    Root scanned for callers (used by --dead). Default: parent of <convex-dir>
-h, --help               Show help
```

Exit codes: `0` no errors (and no warnings under `--strict`), `1` errors found (or warnings under `--strict`), `2` bad arguments.

## Programmatic API

```ts
import { run, reportText, exitCode } from "@fagnersales/convex-doctor";

const result = run({
  convexDir: "convex",
  format: "text",
  includeUnanalyzed: false,
  strict: false,
  lint: true, // run the best-practice lints too (default off in the library API)
});
console.log(reportText(result));
process.exit(exitCode(result, false));
```

`reportJson` and `buildGraph` are exported alongside `run` for JSON output and the call graph.

## Status

Two analysis layers over one shared ts-morph pass: the returns-validator **drift engine** (recursive type compare, discriminated-union scoring, both-branch ternary, `.map`/`Promise.all` tracing, and `ctx.runQuery/runMutation/runAction` cross-function propagation) and ~20 doc-grounded **best-practice rules**, plus optional dead-function detection. See `TODO.md` for known gaps and roadmap.

## License

MIT
