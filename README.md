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

### Suppressing a finding

Not every flagged site should change — a delete loop may be sequential by design, an upsert loop may rely on read-your-writes dedupe. Silence a specific finding with an ignore comment on the flagged line (trailing) or the line directly above it, stating the reason:

```ts
for (const row of rows) {
  if (onRow) await onRow(ctx, row);
  // convex-doctor: ignore AWAIT_IN_LOOP — commits atomically; hooks must run in order
  await ctx.db.delete(row._id);
}
```

The code is required — there is deliberately no blanket `ignore`, so a different issue appearing on the same line still surfaces. Several codes can be listed comma-separated (`// convex-doctor: ignore UNBOUNDED_COLLECT, FILTER_IN_QUERY — tiny legacy table`). Suppressed findings leave the report, `groups`, and the exit code; they're tallied in the text report and listed under `suppressed` in `--json`, so a review can still see what was muted and why. This is the lint counterpart of the dead-code [`keep` comment](#dead-function-detection).

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

Optional. `--dead` builds a call graph across the project and lists every Convex function no caller reaches. Two kinds of references count:

- `api.*` / `internal.*` chains, resolved through barrel re-exports;
- string function names — `"path/to/file:fn"` literals as used by `npx convex run` in scripts, `ConvexHttpClient#query(name)`, or fixture inventories. Only strings that resolve to a real function (barrels included) count.

**Dead means unreachable, not just unreferenced.** A reference coming from a function that is itself dead — or from a self-call, like a paged migration re-scheduling itself — grants no life. So an orphaned entry point takes its whole private-helper cluster into the dead list in one pass. Entries that are only reachable *from* dead code are marked `(referenced only by dead code)` in text output and listed under `transitive` in `--json`.

The analysis can only see this repo. For functions invoked from the outside — another service, a webhook consumer, ops running `npx convex run` by hand — either use `--ignore-dead <pattern>`, or (better, because it lives next to the code and documents *why*) put a keep comment on the line above the export:

```ts
// convex-doctor: keep — run manually by ops during incident cleanup
export const requeueStuckJobs = internalMutation({ ... });
```

Ignored and kept functions are treated as live roots: they're excluded from the dead list **and** everything they call stays alive.

Use `--dead-only` to print just the list, `--ignore-dead <pattern>` to exclude entry points by glob (`*` wildcard, repeatable), and `--project-root <path>` to widen the caller scan beyond the parent of `--convex-dir`.

```bash
bunx @fagnersales/convex-doctor --convex-dir convex --dead-only --ignore-dead 'migrations:*'
```

## CLI

```
groups                   List fixable groups (one per rule code), priority-ordered
agent-guide              Print the agentic fix-loop recipe
--convex-dir <path>      Path to convex/ directory. Default: convex
--schema <path>          Path to schema.ts. Default: <convex-dir>/schema.ts
--only <code|category>   Restrict the report to one rule code or category (the agentic unit)
--include-unanalyzed     Print INFO entries for unanalyzed handlers
--json                   Emit JSON instead of text
--strict                 Exit nonzero if any warnings are present
--no-lint                Skip the best-practice lints (drift checks only)
--dead                   Print the dead-function list after the regular report
--dead-only              Print only the dead list (or dead/transitive/ignored/kept under --json)
--ignore-dead <pattern>  Glob (`*` wildcard) excluding nodes from the dead list; matches
                         count as live roots so their callees survive too. Repeatable
--project-root <path>    Root scanned for callers (used by --dead). Default: parent of <convex-dir>
-h, --help               Show help
```

Exit codes: `0` no errors (and no warnings under `--strict`), `1` errors found (or warnings under `--strict`), `2` bad arguments.

## Agentic usage

convex-doctor is built to be driven by a coding agent. Instead of dumping every failing file at once, work **one rule code at a time**: a _group_ is all issues sharing a code, and the fix within a group is one repeatable recipe. The agent locks a group, fixes every site, re-scans to verify, commits, and moves to the next — a loop that converges to zero with clean, reviewable, per-group commits.

Both outputs are deliberately small so they don't flood an agent's context:

```bash
# 1. the menu — a tiny line per group, highest priority first (errors → warnings → info)
bunx @fagnersales/convex-doctor groups --json

# 2. a BOUNDED batch of the locked group's sites (shared recipe once + per-site fix)
bunx @fagnersales/convex-doctor --only AWAIT_IN_LOOP --json --limit 25

# 3. the loop recipe itself, for the agent to self-orient
bunx @fagnersales/convex-doctor agent-guide
```

`groups --json` returns `{ done, groupCount, remaining, groups[] }`; each entry is just `code`, `severity`, `count`, `files`, and an **`autofix`** capability tag telling the agent how hard to think:

| `autofix` | Meaning |
| --- | --- |
| `mechanical` | The diagnostic fully determines the edit (remove/move a line). Safe to apply without reading surrounding code. |
| `guided` | A deterministic recipe, but the agent must read local context (the field's schema type, the loop body, the query chain) to write it. |
| `manual` | Architectural / cross-file / data-migration judgment. Reason carefully; may need to ask. |

`--only <CODE> --json` returns a compact work-list — `{ total, returned, remaining, rule, sites[] }` — with the shared recipe (`why`, `fix`, `docUrl`, `autofix`) emitted **once** under `rule`, and each `site` carrying only its `file`, `line`, `function`, `message`, optional concise `fixCode`, and a `pointer`. It's capped at `--limit` (default 20; `0` = all), so even a 455-site group stays small. **Re-scanning is the cursor:** fix the batch, re-run the same command, and the fixed sites are gone — the next batch comes back. Loop until `total` is 0, then commit the group.

In Claude Code, the [`/convex-fix`](skills/convex-fix/SKILL.md) skill drives this whole loop end to end.

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
