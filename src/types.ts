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
  | "ANALYZER_ERROR";

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
  /** When set, also build a call graph for HTML output. */
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
  /** Number of incoming edges. `dead` iff `incoming === 0` and !ignored. */
  incoming: number;
  outgoing: number;
  /** True when id matches a `--ignore-dead` pattern — excluded from dead. */
  ignored?: boolean;
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
  /** Node ids with zero incoming edges. */
  dead: string[];
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
