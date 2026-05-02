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
      const synthetic: ReturnIntent = {
        kind: "row",
        table: intent.table,
        drop: intent.drop,
        add: intent.add,
        nullable: false,
      };
      return diffRowAgainstObject(fn, synthetic, page.shape.element, schema);
    }

    case "literal": {
      const objBranch = branches.find((b) => b.kind === "object");
      if (!objBranch || objBranch.kind !== "object") {
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
      return diffLiteralAgainstObject(fn, intent.fields, objBranch);
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

  // R1: missing in validator
  for (const [k, v] of expectedAfterDrop) {
    if (k.startsWith("__spread:")) continue;
    if (!validatorFields.has(k)) {
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
    }
  }

  // R2: stale fields in validator (skip extras the handler explicitly adds)
  for (const [k] of validatorFields) {
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
