import type { Issue, ReturnIntent, Shape, SchemaModel, FieldShape, FunctionInfo } from "./types.ts";
import { rowShape } from "./schema.ts";
import { shapeToValidatorSource } from "./validator.ts";
import { makeIssue } from "./rules.ts";

/**
 * Compare every ReturnIntent against the function's `returns` validator
 * Shape and emit diff issues. The validator may be a union — we pair each
 * intent with the most specific union branch we can find.
 */
export function matchFunction(fn: FunctionInfo, schema: SchemaModel): Issue[] {
  const issues: Issue[] = [];

  if (!fn.returnsValidator) {
    // No `returns` declared — Convex won't validate; not our problem.
    return issues;
  }

  const branches = unfoldUnion(fn.returnsValidator);

  for (const intent of fn.intents) {
    issues.push(...matchIntentAgainstUnion(fn, intent, branches, schema));
  }

  return issues;
}

/**
 * Flatten a union into its member branches. Also unwraps `v.optional(...)`
 * (B18) so an object/primitive hidden inside `v.optional(v.object(...))` is
 * diffable — and so a valid primitive vs `v.optional(v.string())` isn't a
 * false positive. (Whether the field accepts `undefined` is handled at the
 * field level, not here.)
 */
function unfoldUnion(shape: Shape): Shape[] {
  if (shape.kind === "union") return shape.members.flatMap(unfoldUnion);
  if (shape.kind === "optional") return unfoldUnion(shape.inner);
  return [shape];
}

/** True when any branch is `v.any()` (accepts anything) — short-circuit. */
function hasAny(branches: Shape[]): boolean {
  return branches.some((b) => b.kind === "any");
}

/** True when any branch is an unresolved validator (ref / unknown). We can't
 *  prove drift through an opaque branch, so we suppress hard mismatches that
 *  would otherwise be false positives (e.g. `doc(schema,"t")` helpers). (C6) */
function hasOpaqueBranch(branches: Shape[]): boolean {
  return branches.some((b) => b.kind === "ref" || b.kind === "unknown");
}

function matchIntentAgainstUnion(
  fn: FunctionInfo,
  intent: ReturnIntent,
  branches: Shape[],
  schema: SchemaModel,
): Issue[] {
  // v.any() accepts anything — no diff to compute.
  if (hasAny(branches)) return [];
  switch (intent.kind) {
    case "unanalyzed":
      return [
        makeIssue("UNANALYZED", {
          severity: "info",
          filePath: fn.filePath,
          line: fn.line,
          function: fn.exportName,
          message: `Return path could not be statically analyzed`,
          detail: intent.reason,
        }),
      ];

    case "null": {
      const hasNull = branches.some((b) => b.kind === "null");
      if (hasNull) return [];
      return [
        makeIssue("NULL_BRANCH_MISSING", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: "Handler can `return null` but validator does not include v.null()",
        }),
      ];
    }

    case "primitive": {
      const ok = branches.some((b) => primitiveMatches(b, intent.primitive, intent.value));
      if (ok) return [];
      if (hasOpaqueBranch(branches)) return [];
      return [
        makeIssue("TYPE_MISMATCH", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: primitiveMismatchMessage(intent),
          fixCode: { after: primitiveSource(intent) },
        }),
      ];
    }

    case "row": {
      // Null-branch coverage is independent of object-field diffing: compute it
      // once and prepend to every exit (C7).
      const nullIssues: Issue[] =
        intent.nullable && !branches.some((b) => b.kind === "null")
          ? [
              makeIssue("NULL_BRANCH_MISSING", {
                severity: "error",
                filePath: fn.filePath,
                line: fn.returnsValidatorLine,
                function: fn.exportName,
                message: `Handler may return null (e.g. .first()/.unique()/get) but validator does not include v.null()`,
              }),
            ]
          : [];

      const objectBranches = branches.filter(
        (b): b is Shape & { kind: "object" } => b.kind === "object",
      );
      const matched = objectBranches.find((b) => objectIsForTable(b, intent.table));
      if (matched) {
        return [...nullIssues, ...diffRowAgainstObject(fn, intent, matched, schema)];
      }
      if (objectBranches.length === 1) {
        // Single object branch — diff against it even if `_id` table is
        // ambiguous (e.g. ctx.db.get with an un-inferrable id).
        return [...nullIssues, ...diffRowAgainstObject(fn, intent, objectBranches[0]!, schema)];
      }
      if (objectBranches.length === 0) {
        if (hasOpaqueBranch(branches)) return nullIssues; // opaque branch may be the object (C6)
        return [
          ...nullIssues,
          makeIssue("TYPE_MISMATCH", {
            severity: "warn",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns row<${intent.table}> but validator has no matching object branch`,
          }),
        ];
      }
      // Multiple object branches, none matched by `_id` table → one clear
      // diagnostic instead of flooding against an arbitrary branch (C12).
      return [
        ...nullIssues,
        makeIssue("TYPE_MISMATCH", {
          severity: "warn",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Handler returns row<${intent.table}> but no union branch declares _id: v.id("${intent.table}")`,
        }),
      ];
    }

    case "rows": {
      const arr = branches.find((b) => b.kind === "array");
      if (!arr || arr.kind !== "array") {
        if (hasOpaqueBranch(branches)) return [];
        return [
          makeIssue("CARDINALITY_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns rows<${intent.table}> (array) but validator is not v.array(...)`,
            fix: "Wrap the row object in v.array(...) — the query returns multiple documents.",
          }),
        ];
      }
      const inner = arr.element;
      if (inner.kind !== "object") {
        if (inner.kind === "ref" || inner.kind === "unknown" || inner.kind === "any") return [];
        return [
          makeIssue("TYPE_MISMATCH", {
            severity: "warn",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Validator array element is not an object — cannot diff`,
          }),
        ];
      }
      const synthetic: ReturnIntent = {
        kind: "row",
        table: intent.table,
        drop: intent.drop,
        add: intent.add,
        nullable: false,
      };
      return diffRowAgainstObject(fn, synthetic, inner, schema);
    }

    case "paginated": {
      // expected: object { page: array<...>, isDone: boolean, continueCursor: string }
      const objBranch = branches.find((b) => b.kind === "object");
      if (!objBranch || objBranch.kind !== "object") {
        if (hasOpaqueBranch(branches)) return [];
        return [
          makeIssue("CARDINALITY_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns paginated<${intent.table}> but validator is not the paginated object shape`,
          }),
        ];
      }
      const issues: Issue[] = [];
      // The paginated container must carry isDone:boolean + continueCursor:string (B16).
      issues.push(...checkPaginationEnvelope(fn, objBranch));

      const page = objBranch.fields.get("page");
      if (!page || page.shape.kind !== "array") {
        issues.push(
          makeIssue("CARDINALITY_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Paginated validator missing v.array(...) under "page" key`,
          }),
        );
        return issues;
      }
      // Handler explicitly assigned `page: <expr>` (e.g. `{...result, page: pageWithUrls}`).
      if (intent.pageOverride) {
        issues.push(...matchIntentAgainstUnion(fn, intent.pageOverride, [page.shape], schema));
        return issues;
      }
      if (page.shape.element.kind !== "object") {
        if (
          page.shape.element.kind === "ref" ||
          page.shape.element.kind === "unknown" ||
          page.shape.element.kind === "any"
        ) {
          return issues;
        }
        issues.push(
          makeIssue("CARDINALITY_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Paginated validator's "page" array element is not an object — cannot diff against schema row`,
          }),
        );
        return issues;
      }
      const synthetic: ReturnIntent = {
        kind: "row",
        table: intent.table,
        drop: new Set(),
        add: new Map(),
        nullable: false,
      };
      issues.push(...diffRowAgainstObject(fn, synthetic, page.shape.element, schema));
      return issues;
    }

    case "literal": {
      const objBranches = branches.filter(
        (b): b is Shape & { kind: "object" } => b.kind === "object",
      );
      if (objBranches.length === 0) {
        if (hasOpaqueBranch(branches)) return [];
        return [
          makeIssue("TYPE_MISMATCH", {
            severity: "warn",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns object literal but validator has no object branch`,
          }),
        ];
      }
      const best = pickBestBranchForLiteral(intent.fields, objBranches);
      return diffLiteralAgainstObject(fn, intent.fields, best);
    }

    case "literalArray": {
      const arr = branches.find((b) => b.kind === "array");
      if (!arr || arr.kind !== "array") {
        if (hasOpaqueBranch(branches)) return [];
        return [
          makeIssue("CARDINALITY_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns array literal but validator is not v.array(...)`,
            fix: "Wrap the element in v.array(...) to match the array the handler returns.",
          }),
        ];
      }
      const innerBranches = unfoldUnion(arr.element);
      // Diff every distinct element branch (covers `.map(x => cond ? a : b)`).
      const elements = intent.elements ?? [intent.element];
      return elements.flatMap((el) => matchIntentAgainstUnion(fn, el, innerBranches, schema));
    }

    case "idValue": {
      const ok = branches.some((b) => b.kind === "id" && b.table === intent.table);
      if (ok) return [];
      if (hasOpaqueBranch(branches)) return [];
      return [
        makeIssue("TYPE_MISMATCH", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Handler returns id<${intent.table}> (ctx.db.insert) but validator has no matching v.id("${intent.table}")`,
          fixCode: { after: `v.id(${JSON.stringify(intent.table)})` },
        }),
      ];
    }

    case "passthrough": {
      const callerShape: Shape =
        branches.length === 1 ? branches[0]! : { kind: "union", members: branches };
      const mismatch = compareShapes(intent.shape, callerShape);
      if (mismatch) {
        const after = shapeToValidatorSource(intent.shape) ?? undefined;
        return [
          makeIssue("TYPE_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns ${intent.from} — ${mismatch}`,
            fixCode: after ? { after } : undefined,
          }),
        ];
      }
      return [];
    }
  }
}

/** Require `isDone: v.boolean()` + `continueCursor: v.string()` on a paginated
 *  validator. These are part of every paginate() result; omitting them throws. */
function checkPaginationEnvelope(
  fn: FunctionInfo,
  obj: Shape & { kind: "object" },
): Issue[] {
  const issues: Issue[] = [];
  const required: { key: string; kind: Shape["kind"]; source: string }[] = [
    { key: "isDone", kind: "boolean", source: "v.boolean()" },
    { key: "continueCursor", kind: "string", source: "v.string()" },
  ];
  const ENVELOPE_WHY =
    "Every paginate() result carries page, isDone and continueCursor. If the returns validator omits or mistypes one, Convex rejects the result at runtime.";
  for (const { key, kind, source } of required) {
    const fs = obj.fields.get(key);
    if (!fs) {
      issues.push(
        makeIssue("MISSING_FIELD", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Paginated validator is missing required field "${key}"`,
          why: ENVELOPE_WHY,
          fix: `Add ${key}: ${source} to the paginated returns object.`,
          fixCode: { add: `${key}: ${source}` },
        }),
      );
    } else if (fs.shape.kind !== kind && fs.shape.kind !== "any" && fs.shape.kind !== "ref") {
      issues.push(
        makeIssue("TYPE_MISMATCH", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Paginated field "${key}" should be ${source} but validator has ${fs.shape.kind}`,
          why: ENVELOPE_WHY,
          fieldLoc: fs.loc,
          fixCode: { before: fs.loc?.text, after: `${key}: ${source}` },
        }),
      );
    }
  }
  return issues;
}

function objectIsForTable(obj: Shape & { kind: "object" }, table: string): boolean {
  const idField = obj.fields.get("_id");
  if (!idField) return false;
  return idField.shape.kind === "id" && idField.shape.table === table;
}

function diffRowAgainstObject(
  fn: FunctionInfo,
  intent: Extract<ReturnIntent, { kind: "row" }>,
  validatorObj: Shape & { kind: "object" },
  schema: SchemaModel,
): Issue[] {
  const issues: Issue[] = [];
  const table = schema.tables.get(intent.table);
  if (!table && intent.table !== "<unknown>") {
    issues.push(
      makeIssue("UNANALYZED", {
        severity: "warn",
        filePath: fn.filePath,
        line: fn.line,
        function: fn.exportName,
        message: `Return references unknown table "${intent.table}"`,
      }),
    );
    return issues;
  }
  if (!table) {
    // ctx.db.get(id) where id arg's table is unknown — nothing to compare schema-wise
    return issues;
  }

  const expected = (rowShape(table) as Shape & { kind: "object" }).fields;
  // Apply drop set
  const expectedAfterDrop = new Map(expected);
  for (const k of intent.drop) expectedAfterDrop.delete(k);
  // Apply additions (extras in spread). Carry the inferred shape if we have a
  // concrete one (B2); otherwise `any` so we don't invent drift.
  for (const [k, addShape] of intent.add) {
    expectedAfterDrop.set(k, { shape: addShape, optional: false });
  }

  const validatorFields = validatorObj.fields;
  const hasUnresolvedSpread = [...validatorFields.keys()].some((k) =>
    k.startsWith("__spread:"),
  );

  // R1: missing in validator
  for (const [k, v] of expectedAfterDrop) {
    if (k.startsWith("__spread:")) continue;
    if (!validatorFields.has(k)) {
      if (hasUnresolvedSpread) continue; // spread might cover this field
      const after = fieldSource(k, v);
      issues.push(
        makeIssue("MISSING_FIELD", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          table: intent.table,
          message: `Validator is missing field "${k}" present on table "${intent.table}"${
            v.optional ? " (optional)" : ""
          }`,
          fixCode: after ? { add: after } : undefined,
        }),
      );
    } else {
      const vf = validatorFields.get(k)!;
      // R3: optionality mismatch — directional. Only an error when the schema
      // field is optional (can be absent) but the validator demands it (C4).
      // The reverse (schema required, validator optional) never throws.
      if (!intent.add.has(k) && v.optional && !vf.optional) {
        const innerSource = shapeToValidatorSource(vf.shape);
        issues.push(
          makeIssue("OPTIONALITY_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            table: intent.table,
            message: `Field "${k}" optionality mismatch: schema=optional, validator=required`,
            fieldLoc: vf.loc,
            fixCode: innerSource
              ? { before: vf.loc?.text, after: `${k}: v.optional(${innerSource})` }
              : undefined,
          }),
        );
      }
      // R4: recursive shape compare
      const mismatch = compareShapes(v.shape, vf.shape);
      if (mismatch) {
        const after = fieldSource(k, v);
        issues.push(
          makeIssue("TYPE_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            table: intent.table,
            message: `Field "${k}" type mismatch: ${mismatch}`,
            fieldLoc: vf.loc,
            fixCode: after ? { before: vf.loc?.text, after } : undefined,
          }),
        );
      }
    }
  }

  // R2: stale fields in validator (skip extras the handler explicitly adds).
  // Severity is directional: a *required* stale field provably throws (error);
  // an optional one is dead weight (info). (C5)
  for (const [k, vf] of validatorFields) {
    if (k.startsWith("__spread:")) continue; // synthetic, never user-facing
    if (expectedAfterDrop.has(k)) continue;
    if (intent.add.has(k)) continue;
    issues.push(
      makeIssue("STALE_FIELD", {
        severity: vf.optional ? "info" : "error",
        filePath: fn.filePath,
        line: fn.returnsValidatorLine,
        function: fn.exportName,
        table: intent.table,
        message: `Validator has field "${k}"${vf.optional ? " (optional)" : ""} not present on table "${intent.table}" or in handler additions`,
        fieldLoc: vf.loc,
        fixCode: vf.loc ? { remove: vf.loc.text } : { remove: k },
      }),
    );
  }

  return issues;
}

/** Render a `key: v.foo()` fix line for a schema field, or null if unrenderable. */
function fieldSource(key: string, fs: FieldShape): string | null {
  const src = shapeToValidatorSource(fs.shape, { optional: fs.optional });
  return src === null ? null : `${key}: ${src}`;
}

function primitiveMatches(
  branch: Shape,
  primitive: "string" | "number" | "boolean",
  value?: string | number | boolean,
): boolean {
  if (branch.kind === primitive) return true;
  if (branch.kind === "literal") {
    // A value-bounded return (e.g. `return "active"`) only matches a literal
    // branch when the values are equal. An unbounded primitive return (e.g.
    // JSON.stringify result) never satisfies a single literal branch (B17).
    if (value === undefined) return false;
    return branch.value === value;
  }
  return false;
}

function primitiveMismatchMessage(
  intent: Extract<ReturnIntent, { kind: "primitive" }>,
): string {
  if (intent.value !== undefined) {
    return `Handler returns ${JSON.stringify(intent.value)} but no matching branch in validator`;
  }
  return `Handler returns primitive ${intent.primitive} but no matching branch in validator`;
}

function primitiveSource(intent: Extract<ReturnIntent, { kind: "primitive" }>): string {
  // A value-bounded return suggests the precise literal — never widen an enum
  // to `v.string()` (that would silently relax the schema, the opposite of the
  // tool's job).
  if (intent.value !== undefined) return `v.literal(${JSON.stringify(intent.value)})`;
  return `v.${intent.primitive}()`;
}

/**
 * Recursively compare a schema-derived shape (`expected`) against the
 * validator-declared shape (`actual`). Returns null if compatible, or a short
 * human-readable description of the first incompatibility found.
 */
function compareShapes(expected: Shape, actual: Shape): string | null {
  if (expected.kind === "optional") {
    const inner = actual.kind === "optional" ? actual.inner : actual;
    return compareShapes(expected.inner, inner);
  }
  if (actual.kind === "optional") {
    return compareShapes(expected, actual.inner);
  }
  if (expected.kind === "any" || actual.kind === "any") return null;
  if (expected.kind === "ref" || actual.kind === "ref") return null; // unresolved — give up
  if (expected.kind === "unknown" || actual.kind === "unknown") return null;

  if (actual.kind === "union" && expected.kind !== "union") {
    for (const am of actual.members) {
      if (compareShapes(expected, am) === null) return null;
    }
    return `expected ${expected.kind}, no matching union member in validator`;
  }
  if (expected.kind === "union" && actual.kind !== "union") {
    for (const em of expected.members) {
      const m = compareShapes(em, actual);
      if (m) return `the value can be ${shapeBrief(em)}, which the validator doesn't allow`;
    }
    return null;
  }

  if (expected.kind === "literal") {
    const t = typeof expected.value;
    if (
      (actual.kind === "string" && t === "string") ||
      (actual.kind === "number" && t === "number") ||
      (actual.kind === "boolean" && t === "boolean")
    ) {
      return null;
    }
  }

  if (expected.kind !== actual.kind) {
    return `expected ${expected.kind}, validator has ${actual.kind}`;
  }

  switch (expected.kind) {
    case "id": {
      const a = actual as Extract<Shape, { kind: "id" }>;
      if (expected.table !== a.table) {
        return `id table mismatch: schema id<${expected.table}>, validator id<${a.table}>`;
      }
      return null;
    }
    case "literal": {
      const a = actual as Extract<Shape, { kind: "literal" }>;
      if (expected.value !== a.value) {
        return `literal mismatch: schema ${JSON.stringify(expected.value)}, validator ${JSON.stringify(a.value)}`;
      }
      return null;
    }
    case "array": {
      const a = actual as Extract<Shape, { kind: "array" }>;
      const inner = compareShapes(expected.element, a.element);
      return inner ? `array element ${inner}` : null;
    }
    case "record": {
      const a = actual as Extract<Shape, { kind: "record" }>;
      const km = compareShapes(expected.key, a.key);
      if (km) return `record key ${km}`;
      const vm = compareShapes(expected.value, a.value);
      return vm ? `record value ${vm}` : null;
    }
    case "union": {
      const a = actual as Extract<Shape, { kind: "union" }>;
      for (const em of expected.members) {
        const ok = a.members.some((am) => compareShapes(em, am) === null);
        if (!ok) {
          return `validator union missing member ${shapeBrief(em)}`;
        }
      }
      return null;
    }
    case "object": {
      const a = actual as Extract<Shape, { kind: "object" }>;
      for (const [k, vf] of expected.fields) {
        if (k.startsWith("__spread:")) continue;
        const af = a.fields.get(k);
        if (!af) return `missing field "${k}"`;
        // Directional optionality: schema-optional + validator-required throws.
        if (vf.optional && !af.optional) return `field "${k}" must be optional`;
        const inner = compareShapes(vf.shape, af.shape);
        if (inner) return `field "${k}" ${inner}`;
      }
      for (const [k, af] of a.fields) {
        if (k.startsWith("__spread:")) continue;
        // Only a *required* unexpected field provably throws.
        if (!expected.fields.has(k) && !af.optional) {
          return `unexpected field "${k}"`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function shapeBrief(s: Shape): string {
  switch (s.kind) {
    case "literal":
      return JSON.stringify(s.value);
    case "id":
      return `id<${s.table}>`;
    case "array":
      return `${shapeBrief(s.element)}[]`;
    default:
      return s.kind;
  }
}

/**
 * For union returns, pick the branch whose literal-typed fields match the
 * handler's literal values. Fall back to keyset overlap.
 */
function pickBestBranchForLiteral(
  literalFields: Map<string, Shape>,
  branches: (Shape & { kind: "object" })[],
): Shape & { kind: "object" } {
  let best = branches[0]!;
  let bestScore = -Infinity;
  for (const b of branches) {
    let score = 0;
    for (const [k, vf] of b.fields) {
      const lit = literalFields.get(k);
      if (vf.shape.kind === "literal") {
        if (lit?.kind === "literal") {
          if (lit.value === vf.shape.value) score += 100;
          else score -= 100;
        }
      }
      if (lit) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

function diffLiteralAgainstObject(
  fn: FunctionInfo,
  literal: Map<string, Shape>,
  validatorObj: Shape & { kind: "object" },
): Issue[] {
  const issues: Issue[] = [];

  const literalKeys = new Set([...literal.keys()].filter((k) => !k.startsWith("__spread:")));
  const hasSpread = [...literal.keys()].some((k) => k.startsWith("__spread:"));
  for (const k of literalKeys) {
    if (!validatorObj.fields.has(k)) {
      issues.push(
        makeIssue("EXTRA_LITERAL_FIELD", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Handler returns field "${k}" but validator does not include it`,
          fix: `Add "${k}" to the returns validator, or stop returning it from the handler.`,
        }),
      );
    } else {
      // Field present on both sides — compare leaf shapes when we inferred a
      // concrete one for the handler value (B12). `any` never mismatches.
      const litShape = literal.get(k)!;
      const vf = validatorObj.fields.get(k)!;
      const mismatch = compareShapes(litShape, vf.shape);
      if (mismatch) {
        issues.push(
          makeIssue("TYPE_MISMATCH", {
            severity: "error",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Field "${k}" type mismatch: ${mismatch}`,
            fieldLoc: vf.loc,
          }),
        );
      }
    }
  }

  if (hasSpread) return issues; // a spread may supply the "missing" required fields

  for (const [k, v] of validatorObj.fields) {
    if (k.startsWith("__spread:")) continue;
    if (v.optional) continue;
    if (!literalKeys.has(k)) {
      issues.push(
        makeIssue("MISSING_LITERAL_FIELD", {
          severity: "error",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Validator requires field "${k}" but handler literal does not provide it`,
          fieldLoc: v.loc,
          fix: `Set "${k}" in the handler's returned object, or make it v.optional(...) in the validator.`,
        }),
      );
    }
  }

  return issues;
}
