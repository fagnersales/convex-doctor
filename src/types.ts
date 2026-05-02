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
  | { kind: "paginated"; table: string; drop: Set<string>; add: Map<string, Shape> }
  | { kind: "literal"; fields: Map<string, Shape> }
  | { kind: "literalArray"; element: ReturnIntent }
  | { kind: "null" }
  | { kind: "primitive"; primitive: "string" | "number" | "boolean" }
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

export interface Issue {
  severity: IssueSeverity;
  code:
    | "MISSING_FIELD"
    | "STALE_FIELD"
    | "OPTIONALITY_MISMATCH"
    | "TYPE_MISMATCH"
    | "NULL_BRANCH_MISSING"
    | "CARDINALITY_MISMATCH"
    | "EXTRA_LITERAL_FIELD"
    | "MISSING_LITERAL_FIELD"
    | "UNANALYZED";
  filePath: string;
  line: number;
  function: string;
  table?: string;
  message: string;
  detail?: string;
}

export interface RunOptions {
  convexDir: string;
  schemaPath?: string;
  includeUnanalyzed: boolean;
  format: "text" | "json";
  strict: boolean;
}

export interface RunResult {
  issues: Issue[];
  scannedFunctions: number;
  schema: SchemaModel;
}
