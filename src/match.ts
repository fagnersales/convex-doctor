import type { Issue, ReturnIntent, Shape, SchemaModel, FieldShape, FunctionInfo } from "./types.ts";
import { rowShape } from "./schema.ts";

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

function unfoldUnion(shape: Shape): Shape[] {
  if (shape.kind === "union") return shape.members.flatMap(unfoldUnion);
  return [shape];
}

function matchIntentAgainstUnion(
  fn: FunctionInfo,
  intent: ReturnIntent,
  branches: Shape[],
  schema: SchemaModel,
): Issue[] {
  // v.any() accepts anything — no diff to compute.
  if (branches.some((b) => b.kind === "any")) return [];
  switch (intent.kind) {
    case "unanalyzed":
      return [
        {
          severity: "info",
          code: "UNANALYZED",
          filePath: fn.filePath,
          line: fn.line,
          function: fn.exportName,
          message: `Return path could not be statically analyzed`,
          detail: intent.reason,
        },
      ];

    case "null": {
      const hasNull = branches.some((b) => b.kind === "null");
      if (hasNull) return [];
      return [
        {
          severity: "error",
          code: "NULL_BRANCH_MISSING",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: "Handler can `return null` but validator does not include v.null()",
        },
      ];
    }

    case "primitive": {
      const ok = branches.some((b) => b.kind === intent.primitive || b.kind === "literal");
      if (ok) return [];
      return [
        {
          severity: "error",
          code: "TYPE_MISMATCH",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Handler returns primitive ${intent.primitive} but no matching branch in validator`,
        },
      ];
    }

    case "row": {
      // Validator branch should be an object whose `_id` matches table T.
      const objectBranch = branches.find(
        (b) => b.kind === "object" && objectIsForTable(b, intent.table),
      );
      if (!objectBranch || objectBranch.kind !== "object") {
        // Try first object-shaped branch as a fallback (for queries where
        // we can't determine the table from `_id` literal alone, e.g. ctx.db.get).
        const firstObj = branches.find((b) => b.kind === "object");
        if (!firstObj || firstObj.kind !== "object") {
          return [
            {
              severity: "warn",
              code: "TYPE_MISMATCH",
              filePath: fn.filePath,
              line: fn.returnsValidatorLine,
              function: fn.exportName,
              message: `Handler returns row<${intent.table}> but validator has no matching object branch`,
            },
          ];
        }
        return diffRowAgainstObject(fn, intent, firstObj, schema);
      }
      const issues = diffRowAgainstObject(fn, intent, objectBranch, schema);
      if (intent.nullable && !branches.some((b) => b.kind === "null")) {
        issues.push({
          severity: "error",
          code: "NULL_BRANCH_MISSING",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          message: `Handler may return null (e.g. .first()/.unique()/get) but validator does not include v.null()`,
        });
      }
      return issues;
    }

    case "rows": {
      const arr = branches.find((b) => b.kind === "array");
      if (!arr || arr.kind !== "array") {
        return [
          {
            severity: "error",
            code: "CARDINALITY_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns rows<${intent.table}> (array) but validator is not v.array(...)`,
          },
        ];
      }
      const inner = arr.element;
      if (inner.kind !== "object") {
        return [
          {
            severity: "warn",
            code: "TYPE_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Validator array element is not an object — cannot diff`,
          },
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
        return [
          {
            severity: "error",
            code: "CARDINALITY_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns paginated<${intent.table}> but validator is not the paginated object shape`,
          },
        ];
      }
      const page = objBranch.fields.get("page");
      if (!page || page.shape.kind !== "array" || page.shape.element.kind !== "object") {
        return [
          {
            severity: "error",
            code: "CARDINALITY_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Paginated validator missing v.array(v.object(...)) under "page" key`,
          },
        ];
      }
      // Outer drops/adds describe the paginated container (page/isDone/cursor),
      // not the per-row shape. Don't propagate them to the row synthetic.
      const synthetic: ReturnIntent = {
        kind: "row",
        table: intent.table,
        drop: new Set(),
        add: new Map(),
        nullable: false,
      };
      return diffRowAgainstObject(fn, synthetic, page.shape.element, schema);
    }

    case "literal": {
      const objBranches = branches.filter(
        (b): b is Shape & { kind: "object" } => b.kind === "object",
      );
      if (objBranches.length === 0) {
        return [
          {
            severity: "warn",
            code: "TYPE_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns object literal but validator has no object branch`,
          },
        ];
      }
      // Score each branch by literal-discriminator agreement + field overlap.
      const best = pickBestBranchForLiteral(intent.fields, objBranches);
      return diffLiteralAgainstObject(fn, intent.fields, best);
    }

    case "literalArray": {
      const arr = branches.find((b) => b.kind === "array");
      if (!arr || arr.kind !== "array") {
        return [
          {
            severity: "error",
            code: "CARDINALITY_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `Handler returns array literal but validator is not v.array(...)`,
          },
        ];
      }
      // recurse on element
      const innerBranches = unfoldUnion(arr.element);
      return matchIntentAgainstUnion(fn, intent.element, innerBranches, schema);
    }

    case "passthrough": {
      // Handler returns the result of `ctx.runQuery(internal.x.y, ...)` —
      // compare the called function's returns shape against the caller's.
      const callerShape: Shape =
        branches.length === 1 ? branches[0]! : { kind: "union", members: branches };
      const mismatch = compareShapes(intent.shape, callerShape);
      if (mismatch) {
        return [
          {
            severity: "error",
            code: "TYPE_MISMATCH",
            filePath: fn.filePath,
            line: fn.returnsValidatorLine,
            function: fn.exportName,
            message: `runQuery target ${intent.from} ${mismatch}`,
          },
        ];
      }
      return [];
    }
  }
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
    issues.push({
      severity: "warn",
      code: "UNANALYZED",
      filePath: fn.filePath,
      line: fn.line,
      function: fn.exportName,
      message: `Return references unknown table "${intent.table}"`,
    });
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
  // Apply additions (extras in spread)
  for (const [k] of intent.add) {
    expectedAfterDrop.set(k, { shape: { kind: "any" }, optional: false });
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
      // optional fields *can* be omitted from validator only if validator never receives them
      // but Convex stores them on the row → still error. So flag.
      issues.push({
        severity: "error",
        code: "MISSING_FIELD",
        filePath: fn.filePath,
        line: fn.returnsValidatorLine,
        function: fn.exportName,
        table: intent.table,
        message: `Validator is missing field "${k}" present on table "${intent.table}"${
          v.optional ? " (optional)" : ""
        }`,
      });
    } else {
      // R3: optionality mismatch
      const vf = validatorFields.get(k)!;
      if (vf.optional !== v.optional) {
        issues.push({
          severity: "error",
          code: "OPTIONALITY_MISMATCH",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          table: intent.table,
          message: `Field "${k}" optionality mismatch: schema=${
            v.optional ? "optional" : "required"
          }, validator=${vf.optional ? "optional" : "required"}`,
        });
      }
      // R4: recursive shape compare
      const mismatch = compareShapes(v.shape, vf.shape);
      if (mismatch) {
        issues.push({
          severity: "error",
          code: "TYPE_MISMATCH",
          filePath: fn.filePath,
          line: fn.returnsValidatorLine,
          function: fn.exportName,
          table: intent.table,
          message: `Field "${k}" type mismatch: ${mismatch}`,
        });
      }
    }
  }

  // R2: stale fields in validator (skip extras the handler explicitly adds)
  for (const [k] of validatorFields) {
    if (k.startsWith("__spread:")) continue; // synthetic, never user-facing
    if (expectedAfterDrop.has(k)) continue;
    if (intent.add.has(k)) continue;
    issues.push({
      severity: "warn",
      code: "STALE_FIELD",
      filePath: fn.filePath,
      line: fn.returnsValidatorLine,
      function: fn.exportName,
      table: intent.table,
      message: `Validator has field "${k}" not present on table "${intent.table}" or in handler additions`,
    });
  }

  return issues;
}

/**
 * Recursively compare a schema-derived shape (`expected`) against the
 * validator-declared shape (`actual`). Returns null if compatible, or a short
 * human-readable description of the first incompatibility found.
 *
 * Compatibility rules:
 *  - `any` on either side: matches anything.
 *  - kinds must agree (after unwrapping `optional`).
 *  - `id<T>`: table names must agree.
 *  - `literal`: values must agree.
 *  - `array`: recurse on element.
 *  - `record`: recurse on key + value.
 *  - `union`: every member of `expected` must be coverable by some member of
 *    `actual` (so the validator is at least as permissive).
 *  - `object`: skip — handled at field-level by diffRowAgainstObject.
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
      // Field-by-field recursive compare. Skip synthetic spread keys.
      for (const [k, vf] of expected.fields) {
        if (k.startsWith("__spread:")) continue;
        const af = a.fields.get(k);
        if (!af) return `missing field "${k}"`;
        if (vf.optional !== af.optional) return `field "${k}" optionality differs`;
        const inner = compareShapes(vf.shape, af.shape);
        if (inner) return `field "${k}" ${inner}`;
      }
      for (const [k] of a.fields) {
        if (k.startsWith("__spread:")) continue;
        if (!expected.fields.has(k)) {
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
 * For union returns like `v.union(v.object({ok: literal(true), ...}),
 * v.object({ok: literal(false), ...}))`, pick the branch whose literal-typed
 * fields match the handler's literal values. Fall back to keyset overlap.
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
  for (const k of literalKeys) {
    if (!validatorObj.fields.has(k)) {
      issues.push({
        severity: "error",
        code: "EXTRA_LITERAL_FIELD",
        filePath: fn.filePath,
        line: fn.returnsValidatorLine,
        function: fn.exportName,
        message: `Handler returns field "${k}" but validator does not include it`,
      });
    }
  }

  for (const [k, v] of validatorObj.fields) {
    if (v.optional) continue;
    if (!literalKeys.has(k)) {
      issues.push({
        severity: "error",
        code: "MISSING_LITERAL_FIELD",
        filePath: fn.filePath,
        line: fn.returnsValidatorLine,
        function: fn.exportName,
        message: `Validator requires field "${k}" but handler literal does not provide it`,
      });
    }
  }

  return issues;
}
