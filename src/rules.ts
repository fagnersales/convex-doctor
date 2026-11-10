import type { FixCode, Issue, IssueCode, IssueSeverity } from "./types.ts";

/**
 * Diagnostic category — the lens a reader cares about. Issues are grouped by
 * category in the rich report so related drift reads as one story.
 */
export type DiagCategory =
  | "schema-drift"
  | "nullability"
  | "cardinality"
  | "type-mismatch"
  | "literal-shape"
  | "correctness"
  | "performance"
  | "reactivity"
  | "best-practice"
  | "runtime"
  | "coverage";

export interface RuleMeta {
  /** One-line human title (shown next to the code). */
  title: string;
  category: DiagCategory;
  /** Why this matters — the runtime consequence, in plain language. */
  why: string;
  /** Generic fix hint when the matcher can't synthesize a precise one. */
  fixHint: string;
  /** Convex docs deep-link for the reader who wants the full story. */
  docUrl: string;
}

const VALIDATION_DOC = "https://docs.convex.dev/functions/validation";
const PAGINATION_DOC = "https://docs.convex.dev/database/pagination";
const BEST_PRACTICES_DOC = "https://docs.convex.dev/understanding/best-practices/";
const ESLINT_DOC = "https://docs.convex.dev/eslint";

// Deep links to the exact doc section each lint rule is grounded in. Anchors are
// verified against the live pages (the slug for `.`/`/`/backticks is non-obvious:
// e.g. "ctx.runMutation / ctx.runQuery" → "ctxrunmutation--ctxrunquery").
const DOC_AWAIT_LOOP = "https://docs.convex.dev/database/reading-data/#join";
const DOC_FILTER = `${BEST_PRACTICES_DOC}#avoid-filter-on-database-queries`;
const DOC_COLLECT = `${BEST_PRACTICES_DOC}#only-use-collect-with-a-small-number-of-results`;
const DOC_SEQ_RUN = `${BEST_PRACTICES_DOC}#avoid-sequential-ctxrunmutation--ctxrunquery-calls-from-actions`;
const DOC_DATE_IN_QUERY = `${BEST_PRACTICES_DOC}#date-in-queries`;
const DOC_ARG_VALIDATORS = `${BEST_PRACTICES_DOC}#use-argument-validators-for-all-public-functions`;
const DOC_INTERNAL_FNS = `${BEST_PRACTICES_DOC}#only-schedule-and-ctxrun-internal-functions`;
const DOC_OLD_SYNTAX = `${ESLINT_DOC}#no-old-registered-function-syntax`;
const DOC_WRONG_RUNTIME = `${ESLINT_DOC}#import-wrong-runtime`;
const DOC_AWAIT_ALL = `${BEST_PRACTICES_DOC}#await-all-promises`;
const DOC_RUNTIMES = "https://docs.convex.dev/functions/runtimes";
const DOC_QUERY_FNS = "https://docs.convex.dev/functions/query-functions";
const DOC_ACTIONS = "https://docs.convex.dev/functions/actions";
const DOC_CRONS = "https://docs.convex.dev/scheduling/cron-jobs";
const DOC_RUN_SPARINGLY = `${BEST_PRACTICES_DOC}#use-ctxrunquery-and-ctxrunmutation-sparingly-in-queries-and-mutations`;
const DOC_REDUNDANT_INDEX = `${BEST_PRACTICES_DOC}#check-for-redundant-indexes`;
const DOC_SCHEMA_VALIDATION = "https://docs.convex.dev/database/schemas#schemavalidation";

/**
 * Per-code metadata. Severity is deliberately NOT stored here — the same code
 * is emitted at different severities depending on context (e.g. TYPE_MISMATCH
 * is an error for a concrete mismatch but a warning when the validator branch
 * is un-diffable; UNANALYZED is info or warn). The renderer always trusts
 * `Issue.severity`.
 */
export const RULE_META: Record<Issue["code"], RuleMeta> = {
  MISSING_FIELD: {
    title: "Validator omits a field the table stores",
    category: "schema-drift",
    why: "Convex returns every stored field on the row. If the returns validator doesn't list it, validation throws ReturnsValidationError before the caller ever sees the data.",
    fixHint: "Add the missing field to the returns object (use v.optional(...) if the schema field is optional).",
    docUrl: VALIDATION_DOC,
  },
  STALE_FIELD: {
    title: "Validator lists a field the table doesn't have",
    category: "schema-drift",
    why: "The validator declares a field the handler never produces. A required stale field makes every call throw; an optional one is dead weight that drifts further over time.",
    fixHint: "Remove the field from the returns validator, or add it to the schema / handler output if it should exist.",
    docUrl: VALIDATION_DOC,
  },
  OPTIONALITY_MISMATCH: {
    title: "Validator and schema disagree on optionality",
    category: "schema-drift",
    why: "An optional schema field can be absent on the row. If the validator marks it required, every row missing the field throws at runtime.",
    fixHint: "Wrap the validator field in v.optional(...) to match the schema.",
    docUrl: VALIDATION_DOC,
  },
  TYPE_MISMATCH: {
    title: "Validator type disagrees with the return shape",
    category: "type-mismatch",
    why: "Convex checks the runtime value against the validator's type. A category mismatch (string vs number, wrong id table, wrong array element) throws ReturnsValidationError.",
    fixHint: "Change the validator type to match what the handler actually returns.",
    docUrl: VALIDATION_DOC,
  },
  NULL_BRANCH_MISSING: {
    title: "Handler can return null but validator has no v.null()",
    category: "nullability",
    why: ".first(), .unique() and ctx.db.get() return null when nothing is found. If the validator can't be null, that no-result path throws at runtime.",
    fixHint: "Wrap the object branch in a union with v.null(): v.union(<object>, v.null()).",
    docUrl: VALIDATION_DOC,
  },
  CARDINALITY_MISMATCH: {
    title: "Array vs single-object mismatch",
    category: "cardinality",
    why: ".collect()/.take() return an array; .first()/.unique()/get return one document. If the validator's cardinality is the other one, every call throws.",
    fixHint: "Switch the validator between v.array(<element>) and the single object to match the query.",
    docUrl: VALIDATION_DOC,
  },
  EXTRA_LITERAL_FIELD: {
    title: "Handler returns a field the validator doesn't allow",
    category: "literal-shape",
    why: "The handler's object literal includes a key the validator doesn't declare. Convex rejects unknown fields, so the call throws.",
    fixHint: "Either add the field to the validator or stop returning it from the handler.",
    docUrl: VALIDATION_DOC,
  },
  MISSING_LITERAL_FIELD: {
    title: "Validator requires a field the handler never sets",
    category: "literal-shape",
    why: "The validator declares a required field the handler's literal doesn't provide, so the returned object fails validation.",
    fixHint: "Set the field in the handler, or make it v.optional(...) in the validator.",
    docUrl: VALIDATION_DOC,
  },
  REQUIRED_ANY_UNDEFINED: {
    title: "Required v.any() field can receive undefined",
    category: "nullability",
    why: "v.any() accepts any Convex value, but undefined is not one: Convex drops object keys whose value is undefined, and a required v.any() field rejects the missing key. The call throws ReturnsValidationError (or ArgumentValidationError) every time the value is undefined. TypeScript doesn't catch it, because unknown, T | undefined and x?: T are all assignable to the any that Infer<typeof v.any()> produces.",
    fixHint: "Wrap the field in v.optional(v.any()), or make sure the handler always sets a defined value.",
    docUrl: VALIDATION_DOC,
  },
  UNANALYZED: {
    title: "Return path couldn't be analyzed",
    category: "coverage",
    why: "The return expression was too dynamic to trace statically, so drift here can't be ruled out. This is a coverage gap, not a confirmed bug.",
    fixHint: "Consider returning a more direct shape, or verify this path by hand.",
    docUrl: VALIDATION_DOC,
  },
  ANALYZER_ERROR: {
    title: "Analyzer error while processing this function",
    category: "coverage",
    why: "The analyzer threw while tracing this function, so it was skipped. This is a tool limitation, not necessarily a bug in your code.",
    fixHint: "Re-run with the function isolated; if it persists, please report the handler shape that triggered it.",
    docUrl: VALIDATION_DOC,
  },

  // ── Best-practice / lint rules ────────────────────────────────────────────
  AWAIT_IN_LOOP: {
    title: "Awaited database call inside a loop",
    category: "performance",
    why: "Each awaited ctx.db / ctx.runQuery call inside a loop is a separate sequential round-trip. For N items that is N round-trips end to end; the same reads issued together with Promise.all run in parallel and finish in roughly one.",
    fixHint: "Collect the promises and await them together: `await Promise.all(items.map((x) => ctx.db.get(x)))`.",
    docUrl: DOC_AWAIT_LOOP,
  },
  FILTER_IN_QUERY: {
    title: "`.filter()` on a database query",
    category: "performance",
    why: "Query `.filter()` still reads every document the query would return and discards the non-matching ones in memory. An index narrows the read at the database; filtering in plain TypeScript after `.collect()` is no worse and is clearer.",
    fixHint: "Define an index in schema.ts and use `.withIndex(...)`, or drop `.filter()` and filter the array in TypeScript.",
    docUrl: DOC_FILTER,
  },
  UNBOUNDED_COLLECT: {
    title: "`.collect()` on an unindexed query",
    category: "performance",
    why: "`.collect()` loads every matching document into memory. On a query with no index narrowing that is the whole table, which gets slower as the table grows and can blow past Convex read limits.",
    fixHint: "Narrow with `.withIndex(...)`, cap with `.take(n)`, or page with `.paginate(...)`.",
    docUrl: DOC_COLLECT,
  },
  SEQUENTIAL_CTX_RUN: {
    title: "Multiple sequential ctx.runMutation calls in an action",
    category: "performance",
    why: "Each ctx.runMutation is its own transaction. Running several in sequence is slower than one combined mutation and gives up atomicity — a failure halfway through leaves the earlier writes committed.",
    fixHint: "Move the writes into a single mutation and call it once, so they commit atomically in one transaction.",
    docUrl: DOC_SEQ_RUN,
  },
  NONDETERMINISTIC_QUERY: {
    title: "Nondeterministic value in a query",
    category: "reactivity",
    why: "Queries are cached and recomputed only when their inputs change. A value from Date.now() / Math.random() / new Date() is fixed at execution time, so the result never updates as wall-clock time passes — clients see stale data.",
    fixHint: "Compute time in a mutation/action and pass it in as an argument, or accept the timestamp as a query arg.",
    docUrl: DOC_DATE_IN_QUERY,
  },
  MISSING_ARG_VALIDATOR: {
    title: "Public function has no argument validator",
    category: "best-practice",
    why: "A public query/mutation/action is callable by any client. Without an `args` validator the arguments are unchecked at the boundary, so malformed or hostile input reaches the handler directly.",
    fixHint: "Add an `args: { ... }` validator (use `args: {}` if the function genuinely takes none).",
    docUrl: DOC_ARG_VALIDATORS,
  },
  OLD_FUNCTION_SYNTAX: {
    title: "Registered with a bare function instead of `{ handler }`",
    category: "best-practice",
    why: "Passing a function directly to query/mutation/action is the legacy form. It can't carry `args` or `returns` validators, so the function has no input or output validation at all.",
    fixHint: "Wrap it as `query({ args: {...}, handler: async (ctx, args) => { ... } })`.",
    docUrl: DOC_OLD_SYNTAX,
  },
  SCHEDULE_PUBLIC_FN: {
    title: "Scheduling or calling a public `api.*` function server-side",
    category: "best-practice",
    why: "Convex's best-practices guide says to ensure every ctx.runQuery/runMutation/runAction and ctx.scheduler call uses `internal.*`, not `api.*`. A public function is callable by any client (a potential attacker), so a server-internal step left on `api.*` keeps an attack-surface function exposed instead of locking it down as internal.",
    fixHint: "Define the target as an internal* function and reference it as `internal.<module>.<fn>` (or, if a client must also call it, extract the shared logic into a plain helper).",
    docUrl: DOC_INTERNAL_FNS,
  },
  WRONG_RUNTIME_IMPORT: {
    title: "Default-runtime file imports a `\"use node\"` module",
    category: "runtime",
    why: "Files marked `\"use node\"` run in the Node.js runtime; everything else runs in Convex's V8 isolate. Importing a Node-runtime module from a V8 file pulls Node-only code into a runtime that can't load it, failing at deploy or call time.",
    fixHint: "Move the shared code into a runtime-neutral module, or mark this file `\"use node\"` if it really needs the Node runtime.",
    docUrl: DOC_WRONG_RUNTIME,
  },

  // ── Round 2: rules grounded in the full best-practices audit ───────────────
  FLOATING_CTX_PROMISE: {
    title: "Un-awaited Convex call (floating promise)",
    category: "correctness",
    why: "Convex ctx calls (ctx.db.patch, ctx.scheduler.runAfter, ctx.runMutation, …) return promises. Left un-awaited at statement position, the write or schedule may never run and any error is swallowed, so the bug surfaces as silently-missing data rather than a thrown exception.",
    fixHint: "Add `await` before the call (or `void` it / `.catch(...)` it if the fire-and-forget is deliberate).",
    docUrl: DOC_AWAIT_ALL,
  },
  FETCH_IN_QUERY: {
    title: "`fetch()` inside a query or mutation",
    category: "correctness",
    why: "Queries and mutations run in a deterministic V8 isolate that has no `fetch`. Any third-party network call throws at runtime. TypeScript doesn't catch it because the `fetch` global type is present everywhere.",
    fixHint: "Move the third-party call into an `action`, and have it call queries/mutations for the data it needs.",
    docUrl: DOC_QUERY_FNS,
  },
  DB_IN_ACTION: {
    title: "`ctx.db` accessed inside an action",
    category: "correctness",
    why: "Actions don't get a database handle — `ActionCtx` has no `db`. Actions read and write the database only by calling queries and mutations via ctx.runQuery / ctx.runMutation. `ctx.db.*` in an action is a runtime error (and usually a query body pasted into an action).",
    fixHint: "Move the data access into a query/mutation and call it with `ctx.runQuery(...)` / `ctx.runMutation(...)`.",
    docUrl: DOC_ACTIONS,
  },
  QUERY_IN_NODE_FILE: {
    title: "Query or mutation in a `\"use node\"` file",
    category: "correctness",
    why: "A `\"use node\"` file is bundled for the Node.js runtime, which can only host actions. A query or mutation defined there can't run, and Convex rejects the deploy.",
    fixHint: "Move the query/mutation into a file without `\"use node\"`; keep only actions (and their Node helpers) in the Node file.",
    docUrl: DOC_RUNTIMES,
  },
  NODE_BUILTIN_WITHOUT_USE_NODE: {
    title: "Node builtin imported without `\"use node\"`",
    category: "runtime",
    why: "Convex's default V8 isolate has no Node.js builtins. Importing `node:fs`, `path`, `child_process`, etc. in a file with no `\"use node\"` directive fails when the module loads — at deploy or first call.",
    fixHint: "Add `\"use node\";` to the top of the file (only actions can live there), or replace the builtin with a runtime-neutral alternative.",
    docUrl: DOC_RUNTIMES,
  },
  MISPLACED_USE_NODE: {
    title: "`\"use node\"` not at the top of the file",
    category: "runtime",
    why: "The bundler only reads directives in the file prologue. A `\"use node\"` placed after an import or statement is silently ignored, so the file is treated as a V8 file and its Node code fails — with no error pointing at the misplaced directive.",
    fixHint: "Move `\"use node\";` to the very top of the file, above all imports and statements.",
    docUrl: DOC_RUNTIMES,
  },
  CRON_PUBLIC_FN: {
    title: "Cron job schedules a public `api.*` function",
    category: "best-practice",
    why: "The best-practices guide says to check crons.ts and ensure scheduled functions use `internal.*`, not `api.*`. A cron pointing at a public function keeps a server-internal step exposed on your public API, where any client can invoke it.",
    fixHint: "Make the cron's target an internal* function and reference it as `internal.<module>.<fn>`.",
    docUrl: DOC_INTERNAL_FNS,
  },
  DUPLICATE_CRON_ID: {
    title: "Two cron jobs share the same identifier",
    category: "correctness",
    why: "Each cron registration's first argument is a unique identifier. Registering two with the same name makes Convex throw \"Cron identifier registered twice\" and abort the deploy.",
    fixHint: "Give each cron job a distinct identifier string.",
    docUrl: DOC_CRONS,
  },
  CTX_RUN_IN_QUERY_OR_MUTATION: {
    title: "`ctx.runQuery` / `ctx.runMutation` inside a query or mutation",
    category: "performance",
    why: "Inside a query or mutation these run in the same transaction, so they add overhead with no consistency benefit over a plain TypeScript function. (Calling components, or wanting partial rollback in a mutation, are the documented exceptions.)",
    fixHint: "Extract the shared logic into a plain TypeScript helper (e.g. in convex/model) and call it directly.",
    docUrl: DOC_RUN_SPARINGLY,
  },
  REDUNDANT_INDEX: {
    title: "Index field list is a prefix of another index",
    category: "performance",
    why: "An index whose ordered fields are a prefix of another index on the same table is usually redundant — the longer index already serves prefix lookups. The short one costs storage and slows writes. (Keep it only if you rely on its distinct _creationTime ordering within the prefix.)",
    fixHint: "Drop the shorter index and use the longer one; it answers the same prefix queries.",
    docUrl: DOC_REDUNDANT_INDEX,
  },
  SCHEMA_VALIDATION_DISABLED: {
    title: "Schema validation disabled",
    category: "best-practice",
    why: "With `schemaValidation: false`, Convex no longer checks that stored documents match your schema, so the schema becomes documentation rather than an enforced contract — and ccv's own drift detection assumes rows conform to the schema.",
    fixHint: "Re-enable schema validation once your data conforms (this flag is meant as a temporary escape hatch during migrations).",
    docUrl: DOC_SCHEMA_VALIDATION,
  },
};

/**
 * How much judgment an agent needs to apply a rule's fix. Surfaced per group by
 * `convex-doctor groups` so an automated fixer knows how hard to think:
 *  - `mechanical` — the diagnostic fully determines the edit (remove or move a
 *    line); safe to apply without reading the surrounding code.
 *  - `guided` — a deterministic recipe, but the agent must read local context
 *    (the field's schema type, the loop body, the query chain) to write it.
 *  - `manual` — architectural / cross-file / data-migration judgment; the agent
 *    should reason, may need to restructure, and may need to ask first.
 */
export type AutofixCapability = "mechanical" | "guided" | "manual";

/** Per-code fix capability. `Record<IssueCode, …>` keeps this exhaustive — a new
 *  code won't compile until it is classified here. */
export const AUTOFIX: Record<Issue["code"], AutofixCapability> = {
  // schema-drift / validator edits — precise, local validator changes
  MISSING_FIELD: "guided",
  STALE_FIELD: "mechanical",
  OPTIONALITY_MISMATCH: "mechanical",
  TYPE_MISMATCH: "guided",
  NULL_BRANCH_MISSING: "guided",
  CARDINALITY_MISMATCH: "guided",
  EXTRA_LITERAL_FIELD: "guided",
  MISSING_LITERAL_FIELD: "guided",
  REQUIRED_ANY_UNDEFINED: "mechanical",
  // coverage — not a fix, a thing to verify by hand
  UNANALYZED: "manual",
  ANALYZER_ERROR: "manual",
  // best-practice / lint — recipes that need the handler's context
  AWAIT_IN_LOOP: "guided",
  FILTER_IN_QUERY: "guided",
  UNBOUNDED_COLLECT: "guided",
  SEQUENTIAL_CTX_RUN: "guided",
  NONDETERMINISTIC_QUERY: "guided",
  MISSING_ARG_VALIDATOR: "guided",
  OLD_FUNCTION_SYNTAX: "guided",
  SCHEDULE_PUBLIC_FN: "guided",
  WRONG_RUNTIME_IMPORT: "manual",
  FLOATING_CTX_PROMISE: "guided",
  FETCH_IN_QUERY: "manual",
  DB_IN_ACTION: "manual",
  QUERY_IN_NODE_FILE: "manual",
  NODE_BUILTIN_WITHOUT_USE_NODE: "guided",
  MISPLACED_USE_NODE: "mechanical",
  CRON_PUBLIC_FN: "guided",
  DUPLICATE_CRON_ID: "guided",
  CTX_RUN_IN_QUERY_OR_MUTATION: "guided",
  // The edit (drop the shorter index) is trivial, but deciding *whether* to drop
  // needs whole-program judgment — a flagged prefix may be kept for newest-first
  // ordering, and dropping it silently changes query results. So: manual.
  REDUNDANT_INDEX: "manual",
  SCHEMA_VALIDATION_DISABLED: "manual",
};

/** Stable category ordering for grouped output (most actionable first). */
export const CATEGORY_ORDER: DiagCategory[] = [
  "schema-drift",
  "nullability",
  "cardinality",
  "type-mismatch",
  "literal-shape",
  "correctness",
  "performance",
  "reactivity",
  "best-practice",
  "runtime",
  "coverage",
];

export const CATEGORY_LABEL: Record<DiagCategory, string> = {
  "schema-drift": "Schema drift",
  nullability: "Nullability",
  cardinality: "Cardinality",
  "type-mismatch": "Type mismatch",
  "literal-shape": "Literal shape",
  correctness: "Correctness",
  performance: "Performance",
  reactivity: "Reactivity",
  "best-practice": "Best practices",
  runtime: "Runtime",
  coverage: "Coverage",
};

/** Override the default doc link for pagination-specific messages. */
export function docUrlFor(code: Issue["code"], message: string): string {
  if (code === "MISSING_FIELD" && /paginat/i.test(message)) return PAGINATION_DOC;
  return RULE_META[code].docUrl;
}

export interface MakeIssueOpts {
  filePath: string;
  /** Coarse anchor line (usually the `returns:` line or the function line). */
  line: number;
  function: string;
  severity: IssueSeverity;
  message: string;
  table?: string;
  detail?: string;
  /** Precise location of the offending validator field, when known. */
  fieldLoc?: { line: number; column: number; text: string };
  /** Explicit caret pointer (used by lint rules, where the offending token is a
   *  call/identifier rather than a validator field). Takes precedence over
   *  `fieldLoc`. `length` defaults to 1 when omitted. */
  pointer?: { line: number; column: number; length?: number };
  /** Override the generic fix hint with a context-specific instruction. */
  fix?: string;
  /** Override the registry "why" for a context that the generic one misfits
   *  (e.g. pagination envelope fields aren't "fields the table stores"). */
  why?: string;
  /** Structured before/after/add/remove fix. Suppressed by callers when the
   *  underlying shape contains unresolved refs (don't emit v.ref() garbage). */
  fixCode?: FixCode;
}

/**
 * Construct an Issue with rule metadata (category/why/fix/docUrl) and a precise
 * source pointer auto-filled. Every emission site funnels through here so the
 * rich fields are never forgotten.
 */
export function makeIssue(code: IssueCode, opts: MakeIssueOpts): Issue {
  const meta = RULE_META[code];
  const fieldLoc = opts.fieldLoc;
  let pointerLine = opts.line;
  let pointerColumn: number | undefined;
  let pointerLength: number | undefined;
  if (opts.pointer) {
    pointerLine = opts.pointer.line;
    pointerColumn = opts.pointer.column;
    pointerLength = opts.pointer.length ?? 1;
  } else if (fieldLoc) {
    pointerLine = fieldLoc.line;
    pointerColumn = fieldLoc.column;
    // Underline just the field key (text up to the first ':').
    const key = fieldLoc.text.split(":")[0]?.trim() ?? "";
    pointerLength = key.length > 0 ? key.length : undefined;
  }
  return {
    severity: opts.severity,
    code,
    filePath: opts.filePath,
    line: opts.line,
    function: opts.function,
    table: opts.table,
    message: opts.message,
    detail: opts.detail,
    category: meta.category,
    why: opts.why ?? meta.why,
    fix: opts.fix ?? meta.fixHint,
    fixCode: opts.fixCode,
    docUrl: docUrlFor(code, opts.message),
    pointerLine,
    pointerColumn,
    pointerLength,
  };
}
