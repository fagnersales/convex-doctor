<img src="site/assets/logos/logomark.svg" alt="convex-doctor" width="40" height="40">

# convex-doctor

[![version](https://img.shields.io/npm/v/@fagnersales/convex-doctor?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/@fagnersales/convex-doctor)
[![downloads](https://img.shields.io/npm/dt/@fagnersales/convex-doctor.svg?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/@fagnersales/convex-doctor)
[![license](https://img.shields.io/npm/l/@fagnersales/convex-doctor?style=flat&colorA=000000&colorB=000000)](LICENSE)

Your agent writes the Convex, this keeps it honest.

convex-doctor deterministically scans your Convex codebase in one pass: **returns-validator drift** (typecheck passes, runtime throws), **best-practice lints** (the whole guide, enforced), and **dead-function detection** (unreachable, not just unreferenced). Every finding ships why · fix · doc link — text for you, JSON for agents.

No install step, no config file. Runs on [Bun](https://bun.sh).

[Website →](https://convex-doctor.vercel.app)

## Install

### 1. Quick start

Run this inside any Convex project to get an audit:

```bash
bunx @fagnersales/convex-doctor
```

```
✖ MISSING_FIELD · validator omits a schema field
   users.ts:31 · getUser

   31 │     name: v.string(),
      │     ^^^^ schema `users` also requires `email`

   why  the first real row returned fails validation at runtime — typecheck never sees it.
   fix  add email: v.string() to the validator.
```

Non-default directory: `--convex-dir backend/convex`.

### 2. Run with your agent

Paste this into your agent of choice:

```
Run: bunx @fagnersales/convex-doctor groups --json
Fix one rule code at a time:
1. lock a group: bunx @fagnersales/convex-doctor --only <CODE> --json
2. fix every site with the group's shared recipe
3. re-scan until the group reads zero, then commit
Repeat until the scan is clean.
```

Both outputs are deliberately small — one line per group, then a bounded work-list with the shared recipe once and just file · line · function per site. Fixed sites vanish from the next run: **re-scanning is the cursor**. Every group carries an `autofix` tag (`mechanical` · `guided` · `manual`) telling the agent how hard to think.

In Claude Code, the [`/convex-fix`](skills/convex-fix/SKILL.md) skill runs the whole loop itself — audit, fix, verify, commit.

### 3. Wire into typecheck

```jsonc
"scripts": {
  "doctor": "bunx @fagnersales/convex-doctor",
  "typecheck": "tsgo --noEmit && bun doctor"
}
```

Exit codes: `0` no errors — deploy away · `1` errors found (or warnings, under `--strict`) · `2` bad arguments.

### 4. Consume JSON

Add `--json` for a versioned, CI-friendly contract (`schemaVersion`, `summary`, rich per-issue fields). The full physical:

```bash
bunx @fagnersales/convex-doctor --dead --strict --json
```

## What it checks

### 01 · Drift engine

Your agent adds the field, ships the feature — and never touches the `returns` validator. TypeScript can't see it; Convex throws `ReturnsValidationError` at runtime. convex-doctor diffs **schema → validator → every return path** — through joins, spreads, `.paginate()` envelopes, and cross-file imports.

<details>
<summary>All drift codes</summary>

| Code | Severity | Description |
| --- | --- | --- |
| `MISSING_FIELD` | error | Schema has a field; the row-return validator omits it. |
| `STALE_FIELD` | error / info | Validator lists a field schema doesn't have. **error** when required (provably throws); **info** when optional. |
| `OPTIONALITY_MISMATCH` | error | Schema field is optional but the validator requires it (directional — the safe direction is not flagged). |
| `NULL_BRANCH_MISSING` | error | Handler can return `null` (`.first()` / `.unique()` / `ctx.db.get`) but validator lacks `v.null()`. Early-exit null guards suppress it. |
| `CARDINALITY_MISMATCH` | error | `.collect()` returns an array but the validator is a single object (and vice versa). |
| `EXTRA_LITERAL_FIELD` | error | Handler literal returns a field the validator doesn't declare. |
| `MISSING_LITERAL_FIELD` | error | Validator requires a field the handler literal never sets. |
| `TYPE_MISMATCH` | error | Type categories disagree (primitive vs object, wrong `id<T>` table, wrong array element, paginated envelope, …). |
| `UNANALYZED` | info | Handler return too dynamic to trace. Off by default — `--include-unanalyzed`. |
| `ANALYZER_ERROR` | error | The analyzer threw on one function; that function is skipped, the rest of the run is unaffected. |

It understands the code you actually write: foreign-key joins, enrichment spreads, `ctx.storage.getUrl()`, count queries, value-bounded literals, paginated envelopes, spread schema tables, `satisfies Validator<…>`, and validators imported across files.

</details>

### 02 · Best-practice lints

The [best-practices guide](https://docs.convex.dev/understanding/best-practices/), the official [`@convex-dev/eslint-plugin`](https://docs.convex.dev/eslint), and the rules they don't ship — no ESLint install, no config (`--no-lint` to skip).

<details>
<summary>All lint rules</summary>

| Code | Severity | Description |
| --- | --- | --- |
| `AWAIT_IN_LOOP` | warn / info | `await ctx.db.*` in a loop — sequential round-trips; use `Promise.all`. Pagination cursors exempt. |
| `FILTER_IN_QUERY` | warn | `.filter()` on a db query scans every row — use `.withIndex` or filter in TypeScript. |
| `UNBOUNDED_COLLECT` | warn | `.collect()` with no index narrowing can load the whole table — bound with `.withIndex`, `.take(n)`, or `.paginate()`. |
| `NONDETERMINISTIC_QUERY` | warn | `Date.now()` / `Math.random()` / `new Date()` inside a query freezes in the reactive cache. |
| `SEQUENTIAL_CTX_RUN` | info | Multiple `await ctx.runMutation(...)` in one action — separate transactions; consolidate for atomicity. |
| `MISSING_ARG_VALIDATOR` | warn / info | No `args` validator — client input reaches the handler unchecked. **warn** public, **info** internal. |
| `OLD_FUNCTION_SYNTAX` | warn | `query(fn)` instead of `query({ handler })` — can't carry `args`/`returns` validators. |
| `SCHEDULE_PUBLIC_FN` | warn | Schedulers should call `internal.*` — a public `api.*` function is reachable by any client. |
| `WRONG_RUNTIME_IMPORT` | warn | A V8-runtime file importing from a `"use node"` module. |
| `FLOATING_CTX_PROMISE` | warn | An un-awaited `ctx.*` write or schedule may never run — errors swallowed silently. |
| `FETCH_IN_QUERY` | error | The V8 isolate has no `fetch` — a query that calls it throws, every time. Belongs in an action. |
| `DB_IN_ACTION` | error | `ActionCtx` has no `ctx.db` — use `ctx.runQuery` / `ctx.runMutation`. |
| `QUERY_IN_NODE_FILE` | error | A query in a `"use node"` file — Convex rejects the deploy outright. |
| `NODE_BUILTIN_WITHOUT_USE_NODE` | warn | A Node builtin imported in a file with no `"use node"`. |
| `MISPLACED_USE_NODE` | warn | A `"use node"` directive not at the top of the file — silently ignored. |
| `CRON_PUBLIC_FN` | warn | A cron job scheduling a public `api.*` function. |
| `DUPLICATE_CRON_ID` | error | Two cron jobs under one identifier — deploy-time rejection caught at your desk. |
| `CTX_RUN_IN_QUERY_OR_MUTATION` | info | `ctx.runQuery` inside a query/mutation — overhead with no benefit; use a plain helper. |
| `REDUNDANT_INDEX` | warn | `by_a` is dead weight when `by_a_b` exists — a prefix index duplicates the longer one. |
| `SCHEMA_VALIDATION_DISABLED` | info | `schemaValidation: false` — schema no longer enforced at runtime. |

</details>

Not every flagged site should change. Silence a specific finding with an ignore comment stating the reason — the code is required, so a different issue on the same line still surfaces:

```ts
// convex-doctor: ignore AWAIT_IN_LOOP — commits atomically; hooks must run in order
await ctx.db.delete(row._id);
```

### 03 · Dead-function detection

`--dead` builds a project-wide call graph and lists every function no caller reaches. Dead callers grant no life — an orphaned entry point drags its whole helper cluster with it. `api.*` / `internal.*` chains resolve through barrel re-exports; `"path/file:fn"` string literals count as callers; self-calls don't.

For entry points only the outside world calls, put the reason next to the code:

```ts
// convex-doctor: keep — run manually by ops during incident cleanup
export const requeueStuckJobs = internalMutation({ ... });
```

Kept and `--ignore-dead <glob>` functions are live roots — excluded from the dead list, and everything they call stays alive.

## CLI

```
groups                   List fixable groups (one per rule code), priority-ordered
agent-guide              Print the agentic fix-loop recipe
--convex-dir <path>      Path to convex/ directory. Default: convex
--schema <path>          Path to schema.ts. Default: <convex-dir>/schema.ts
--only <code|category>   Restrict the report to one rule code or category (the agentic unit)
--limit <n>              Cap --only work-lists (default 20; 0 = all)
--include-unanalyzed     Print INFO entries for unanalyzed handlers
--json                   Emit JSON instead of text (versioned, CI-friendly)
--strict                 Exit nonzero if any warnings are present
--no-lint                Skip the best-practice lints (drift checks only)
--dead                   Print the dead-function list after the regular report
--dead-only              Print only the dead list
--ignore-dead <pattern>  Glob excluding entry points from the dead list. Repeatable
--project-root <path>    Root scanned for callers. Default: parent of <convex-dir>
-h, --help               Show help
```

## Programmatic API

```ts
import { run, reportText, exitCode } from "@fagnersales/convex-doctor";

const result = run({ convexDir: "convex", lint: true });
console.log(reportText(result));
process.exit(exitCode(result, false));
```

`reportJson` and `buildGraph` are exported alongside `run`.

## License

MIT · Not affiliated with Convex, Inc. · All checks, no breakages
