# check-convex-validators

Static analyzer that catches `ReturnsValidationError` drift in Convex codebases — _before_ deploy.

The bug class it targets:

> The `returns` validator on a query/mutation drifts away from the schema, the handler return shape, or both — so the validator passes typecheck but throws at runtime when a real row is returned.

It walks `convex/schema.ts` + every `query | mutation | action | internal*` definition, infers what each handler can return, and compares that against the declared `returns` validator. Issues are emitted with file/line for fast triage.

## Quick start

```bash
# inside any Convex project
bunx check-convex-validators

# scan a non-default convex dir
bunx check-convex-validators --convex-dir backend/convex

# wire into your typecheck step
"typecheck": "tsgo --noEmit && bunx check-convex-validators"
```

## What it detects

| Code | Severity | Description |
| --- | --- | --- |
| `MISSING_FIELD` | error | Schema has a field; the row-return validator omits it (the original drift bug). |
| `STALE_FIELD` | warn | Validator lists a field schema doesn't have (or handler doesn't add). |
| `OPTIONALITY_MISMATCH` | error | Schema/validator disagree on whether a field is optional. |
| `NULL_BRANCH_MISSING` | error | Handler can return `null` (e.g. `.first()` / `.unique()` / `ctx.db.get`) but validator lacks `v.null()`. |
| `CARDINALITY_MISMATCH` | error | `.collect()` returns array but validator is single object (and vice versa). |
| `EXTRA_LITERAL_FIELD` | error | Handler literal returns a field the validator doesn't declare. |
| `MISSING_LITERAL_FIELD` | error | Validator requires a field the handler literal never sets. |
| `TYPE_MISMATCH` | error | Top-level type categories disagree (e.g. handler returns `boolean`, validator only allows objects). |
| `UNANALYZED` | info | Handler return is too dynamic to trace (helper call, multi-spread, etc.). Off by default — use `--include-unanalyzed`. |

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

## CLI

```
--convex-dir <path>     Default: convex
--schema <path>         Default: <convex-dir>/schema.ts
--include-unanalyzed    Print INFO entries for unanalyzed handlers
--json                  Machine-readable output
--strict                Exit nonzero on warnings too
-h, --help              Show help
```

## Programmatic API

```ts
import { run, reportText, exitCode } from "check-convex-validators";

const result = run({
  convexDir: "convex",
  format: "text",
  includeUnanalyzed: false,
  strict: false,
});
console.log(reportText(result));
process.exit(exitCode(result, false));
```

## Status

v0.1.0 — covers the high-frequency drift patterns. See `TODO.md` for known gaps and roadmap.

## License

MIT
