/**
 * Shape ADT — recursive description of a Convex validator's structure.
 * Built from `v.*` calls in source. Compared against schema field shape +
 * handler return intent to detect drift.
 */
export type Shape =
  | { kind: "any" }
  | { kind: "null" }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "int64" }
  | { kind: "boolean" }
  | { kind: "bytes" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "id"; table: string }
  | { kind: "array"; element: Shape }
  | { kind: "record"; key: Shape; value: Shape }
  | { kind: "object"; fields: Map<string, FieldShape> }
  | { kind: "union"; members: Shape[] }
  | { kind: "optional"; inner: Shape }
  | { kind: "ref"; symbol: string; resolved?: Shape } // imported validator
  /** convex-helpers `doc(schema, "table")` / `vv.doc("table")` — provably a
   *  single object (never an array). Resolved to the table's object shape when
   *  the schema is known; otherwise kept opaque at the field level but still
   *  diffable for cardinality. */
  | { kind: "docRef"; table: string }
  | { kind: "unknown"; reason: string };

export interface FieldShape {
  shape: Shape;
  optional: boolean;
  /** Source location of the field in the validator, for precise diagnostics.
   *  Captured when the shape comes from a parsed `v.object({...})` property. */
  loc?: { line: number; column: number; text: string };
}

export interface TableSchema {
  table: string;
  fields: Map<string, FieldShape>;
  /** location in schema.ts for diagnostics */
  filePath: string;
  line: number;
}

export interface SchemaModel {
  tables: Map<string, TableSchema>;
}

/**
 * Inferred return intent from a handler body. One handler may have multiple
 * return paths (e.g. `return null` vs `return doc`); we collect all.
 */
export type ReturnIntent =
  | { kind: "row"; table: string; drop: Set<string>; add: Map<string, Shape>; nullable: boolean }
  | { kind: "rows"; table: string; drop: Set<string>; add: Map<string, Shape> }
  | {
      kind: "paginated";
      table: string;
      drop: Set<string>;
      add: Map<string, Shape>;
      /** Set when handler explicitly overrides `page` with its own array
       *  (e.g. `return { ...result, page: pageWithUrls }`). The matcher
       *  validates this intent against the validator's `page.element`
       *  instead of synthesizing a row<T> from the schema. */
      pageOverride?: ReturnIntent;
    }
  | { kind: "literal"; fields: Map<string, Shape> }
  | {
      kind: "literalArray";
      element: ReturnIntent;
      /** Set when the array's callback has multiple distinct element shapes
       *  (e.g. `.map(x => cond ? a : b)`). The matcher diffs every entry. */
      elements?: ReturnIntent[];
    }
  | { kind: "null" }
  | {
      kind: "primitive";
      primitive: "string" | "number" | "boolean";
      /** Set when the return is a literal value (e.g. `return "active"`), so
       *  the matcher can check it against a `v.literal(...)` branch by value. */
      value?: string | number | boolean;
    }
  /** Result of `ctx.db.insert("T", {...})` — Convex returns `Id<"T">`. */
  | { kind: "idValue"; table: string }
  /** Result of `ctx.runQuery/runMutation/runAction(internal.x.y, ...)` —
   *  shape comes from the called function's `returns` validator. */
  | { kind: "passthrough"; shape: Shape; from: string }
  | { kind: "unanalyzed"; reason: string };

export interface FunctionInfo {
  filePath: string;
  line: number;
  exportName: string;
  kind: "query" | "mutation" | "action" | "internalQuery" | "internalMutation" | "internalAction";
  returnsValidator: Shape | null;
  returnsValidatorLine: number;
  intents: ReturnIntent[];
  /** True when a `convex-doctor: keep` comment precedes the export — the
   *  function is invoked externally (`npx convex run`, another repo, a
   *  webhook) and must never be reported dead. */
  keep?: boolean;
}

export type IssueSeverity = "error" | "warn" | "info";

export type IssueCode =
  | "MISSING_FIELD"
  | "STALE_FIELD"
  | "OPTIONALITY_MISMATCH"
  | "TYPE_MISMATCH"
  | "NULL_BRANCH_MISSING"
  | "CARDINALITY_MISMATCH"
  | "EXTRA_LITERAL_FIELD"
  | "MISSING_LITERAL_FIELD"
  | "UNANALYZED"
  /** The analyzer itself threw while processing one function — emitted so a
   *  single bad function never silently drops out of the report. */
  | "ANALYZER_ERROR"
  // ── Best-practice / lint codes (emitted only when RunOptions.lint) ──────
  /** `await ctx.db.*` / `ctx.runX` / `ctx.scheduler.*` inside a for/for-of loop
   *  — sequential round-trips that should be parallelized with Promise.all. */
  | "AWAIT_IN_LOOP"
  /** `.filter(...)` on a `ctx.db.query(...)` chain — scans the table; use an
   *  index (`.withIndex`) or filter in plain TypeScript instead. */
  | "FILTER_IN_QUERY"
  /** `.collect()` on an unindexed query — can load the whole table; bound it
   *  with `.withIndex`, `.take(n)`, or `.paginate()`. */
  | "UNBOUNDED_COLLECT"
  /** Multiple sequential `await ctx.runMutation(...)` in one action — each is a
   *  separate transaction; consolidate into one. */
  | "SEQUENTIAL_CTX_RUN"
  /** `Date.now()` / `Math.random()` / `new Date()` in a query — breaks the
   *  reactive cache (results never update with wall-clock time). */
  | "NONDETERMINISTIC_QUERY"
  /** A public function with no `args:` validator — unvalidated client input. */
  | "MISSING_ARG_VALIDATOR"
  /** `query(fn)` instead of `query({ handler: fn })` — the bare-function form
   *  can't carry `args`/`returns` validators. */
  | "OLD_FUNCTION_SYNTAX"
  /** Scheduling / `ctx.runX` against a PUBLIC `api.*` reference instead of
   *  `internal.*` — exposes server-internal calls on the public API surface. */
  | "SCHEDULE_PUBLIC_FN"
  /** A default-runtime (V8) file importing from a `"use node"` file — the Node
   *  module can't load in the Convex runtime. */
  | "WRONG_RUNTIME_IMPORT"
  /** A promise-returning `ctx.*` call left un-awaited at statement position — the
   *  write/schedule may never happen and errors are swallowed. */
  | "FLOATING_CTX_PROMISE"
  /** `fetch()` (or other third-party I/O) inside a query/mutation — not available
   *  in the V8 query/mutation isolate; throws. Belongs in an action. */
  | "FETCH_IN_QUERY"
  /** `ctx.db.*` inside an action handler — ActionCtx has no `db`; actions reach
   *  the database via ctx.runQuery / ctx.runMutation. */
  | "DB_IN_ACTION"
  /** A query/mutation registered in a `"use node"` file — can't run in Node;
   *  the deploy is rejected. */
  | "QUERY_IN_NODE_FILE"
  /** A Node-only builtin (`node:fs`, `path`, …) imported in a default-runtime
   *  file with no `"use node"` directive. */
  | "NODE_BUILTIN_WITHOUT_USE_NODE"
  /** A `"use node"` directive that is not in the file prologue — silently dropped
   *  by the bundler, so the file is wrongly treated as a V8 file. */
  | "MISPLACED_USE_NODE"
  /** A cron job (`crons.interval`/`daily`/…) scheduling a public `api.*` function
   *  instead of `internal.*`. */
  | "CRON_PUBLIC_FN"
  /** Two cron jobs registered with the same identifier — Convex rejects the
   *  deploy ("Cron identifier registered twice"). */
  | "DUPLICATE_CRON_ID"
  /** `ctx.runQuery` / `ctx.runMutation` inside a query/mutation — same-transaction
   *  overhead with no benefit; use a plain TypeScript helper. */
  | "CTX_RUN_IN_QUERY_OR_MUTATION"
  /** A schema index whose field list is a strict prefix of another index on the
   *  same table (`by_a` when `by_a_b` exists) — usually droppable. */
  | "REDUNDANT_INDEX"
  /** `defineSchema(..., { schemaValidation: false })` — Convex stops enforcing the
   *  schema at runtime, voiding the invariant the drift detector relies on. */
  | "SCHEMA_VALIDATION_DISABLED";

/** A concrete, copy-pasteable fix suggestion. Only the relevant keys are set. */
export interface FixCode {
  /** The validator source as it reads today (the offending fragment). */
  before?: string;
  /** What it should read instead. */
  after?: string;
  /** A line to add (e.g. a missing field). */
  add?: string;
  /** A line/fragment to remove (e.g. a stale field). */
  remove?: string;
}

export interface Issue {
  severity: IssueSeverity;
  code: IssueCode;
  filePath: string;
  line: number;
  function: string;
  table?: string;
  message: string;
  detail?: string;
  // ── Rich diagnostic fields (filled by makeIssue from the rule registry) ──
  /** Diagnostic category — for grouping in the report. */
  category?: import("./rules.ts").DiagCategory;
  /** Plain-language "why this matters" (runtime consequence). */
  why?: string;
  /** Short, human fix instruction. */
  fix?: string;
  /** Structured, copy-pasteable fix (before/after/add/remove). */
  fixCode?: FixCode;
  /** Convex docs deep-link. */
  docUrl?: string;
  /** Precise pointer for the source excerpt (defaults to `line`). */
  pointerLine?: number;
  /** 0-based column of the offending token, for the caret. */
  pointerColumn?: number;
  /** Length of the caret underline. */
  pointerLength?: number;
}

export interface RunOptions {
  convexDir: string;
  schemaPath?: string;
  includeUnanalyzed: boolean;
  format: "text" | "json";
  strict: boolean;
  /** Run the best-practice / lint rules (await-in-loop, .filter-in-query,
   *  unbounded .collect, missing arg validators, etc.) in addition to the
   *  returns-validator drift checks. The CLI defaults this ON; the core
   *  `run()` defaults it OFF so drift-only callers stay unaffected. */
  lint?: boolean;
  /** When set, build the call graph used by dead-function detection (--dead). */
  buildGraph?: boolean;
  /** Root directory to scan for callers (default: parent of convexDir). */
  projectRoot?: string;
  /** Glob patterns (`*` wildcard) matched against node ids. Matching
   *  nodes are excluded from the `dead` list and rendered as ignored. */
  ignoreDead?: string[];
}

/**
 * Call-graph node. Each Convex function definition gets one node.
 * `id` = `<relPathUnderConvex>:<exportName>` (e.g. `charges/queries:list`).
 */
export interface GraphNode {
  id: string;
  exportName: string;
  filePath: string;
  line: number;
  kind: FunctionInfo["kind"];
  /** Number of incoming edges. Note a node can have incoming > 0 and still be
   *  dead: dead = unreachable from any external caller, so edges from other
   *  dead functions (or from itself) don't count as life. */
  incoming: number;
  outgoing: number;
  /** True when id matches a `--ignore-dead` pattern — excluded from dead and
   *  treated as a live root (its callees stay alive). */
  ignored?: boolean;
  /** True when the definition carries a `convex-doctor: keep` comment —
   *  excluded from dead and treated as a live root, like `ignored`. */
  kept?: boolean;
}

/**
 * One directed edge: caller → callee.
 * Caller is either another Convex function node id, or a synthetic
 * `external:<relPath>` id representing a non-Convex call site (React
 * hook, server action, cron registration, etc.).
 */
export interface GraphEdge {
  from: string;
  to: string;
  /** Where the reference lives — for click-to-source. */
  filePath: string;
  line: number;
  /** `runQuery` / `runMutation` / `runAction` / `useQuery` / `external` / ... */
  via: string;
}

export interface CallGraph {
  nodes: GraphNode[];
  /** External caller pseudo-nodes (one per file that calls into Convex). */
  externals: { id: string; filePath: string; outgoing: number }[];
  edges: GraphEdge[];
  /** Node ids unreachable from every external caller (and not ignored/kept).
   *  Includes both directly-unreferenced functions and functions referenced
   *  only by other dead functions or by themselves. */
  dead: string[];
  /** Subset of `dead` with incoming > 0 — referenced, but only from dead
   *  code (or a self-call). Deleting their dead callers orphans them. */
  deadTransitive: string[];
  /** Files scanned for callers. */
  scannedFiles: number;
}

export interface Timings {
  /** ts-morph project bootstrap + glob expansion + source-file load. */
  fileLoadMs: number;
  /** parseSchema(schema.ts). */
  schemaParseMs: number;
  /** Pass 1 — collect every query/mutation/action and resolve their args + returns validators. */
  collectMs: number;
  /** Pass 2 — analyze handler bodies and diff against validators. */
  analyzeMs: number;
  /** End-to-end wall-clock. */
  totalMs: number;
  /** Source files loaded into ts-morph (excludes _generated and tests). */
  filesLoaded: number;
}

export interface RunSummary {
  errors: number;
  warns: number;
  infos: number;
  scannedFunctions: number;
  /** Distinct functions with ≥1 error — the ones that will actually throw. */
  affectedFns: number;
  /** Most frequent issue code (errors weighted first), or null when clean. */
  topCode: IssueCode | null;
  /** Issue count per category. */
  byCategory: Record<import("./rules.ts").DiagCategory, number>;
  /** Issue count per code. */
  byCode: Partial<Record<IssueCode, number>>;
  /** One-line headline summarizing runtime risk. */
  headline: string;
}

export interface RunResult {
  issues: Issue[];
  scannedFunctions: number;
  schema: SchemaModel;
  timings: Timings;
  /** All Convex functions discovered (one record per export). */
  functions: FunctionInfo[];
  /** Present only when `RunOptions.buildGraph` is true. */
  graph?: CallGraph;
  /** Tally + headline, computed once after matching. */
  summary?: RunSummary;
}
