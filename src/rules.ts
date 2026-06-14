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
};

/** Stable category ordering for grouped output (most actionable first). */
export const CATEGORY_ORDER: DiagCategory[] = [
  "schema-drift",
  "nullability",
  "cardinality",
  "type-mismatch",
  "literal-shape",
  "coverage",
];

export const CATEGORY_LABEL: Record<DiagCategory, string> = {
  "schema-drift": "Schema drift",
  nullability: "Nullability",
  cardinality: "Cardinality",
  "type-mismatch": "Type mismatch",
  "literal-shape": "Literal shape",
  coverage: "Coverage",
};

/** Override the default doc link for pagination-specific messages. */
export function docUrlFor(code: Issue["code"], message: string): string {
  if (/paginat/i.test(message)) return PAGINATION_DOC;
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
  let pointerColumn: number | undefined;
  let pointerLength: number | undefined;
  if (fieldLoc) {
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
    pointerLine: fieldLoc?.line ?? opts.line,
    pointerColumn,
    pointerLength,
  };
}
