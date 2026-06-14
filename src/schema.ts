import { Node, SyntaxKind, type SourceFile, type Project } from "ts-morph";
import { parseValidator, resolveRef, findDefinition } from "./validator.ts";
import type { SchemaModel, TableSchema, FieldShape, Shape } from "./types.ts";

/**
 * Parse `convex/schema.ts` into a SchemaModel.
 *
 * Walks `defineSchema({ tableA: defineTable({...}), ... })`. For each table,
 * extracts field shapes from the `defineTable` argument. Spread tables (e.g.
 * `...someExternalTables`) are skipped — they live in another file/package
 * and we can't reach them generically.
 *
 * System fields (_id, _creationTime) are NOT added here. Add them at compare
 * time when matching against a row return.
 */
export function parseSchema(sourceFile: SourceFile, project: Project): SchemaModel {
  const tables = new Map<string, TableSchema>();

  const defineSchemaCall = findDefineSchemaCall(sourceFile);
  if (!defineSchemaCall) return { tables };

  const arg = defineSchemaCall.getArguments()[0];
  if (!arg || !Node.isObjectLiteralExpression(arg)) return { tables };

  for (const prop of arg.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const tableName = propertyName(prop);
      if (!tableName) continue;
      const init = prop.getInitializer();
      if (!init) continue;

      const fields = extractTableFields(init, sourceFile, project);
      if (!fields) continue;

      tables.set(tableName, {
        table: tableName,
        fields,
        filePath: sourceFile.getFilePath(),
        line: prop.getStartLineNumber(),
      });
    } else if (Node.isSpreadAssignment(prop)) {
      // `...sharedTables` — inline a spread table group when it resolves to a
      // local object literal of `name: defineTable(...)` entries (B6). Common
      // for shared/auth table bundles. Unresolvable (node_modules) spreads are
      // skipped, first-writer-wins so explicit tables override.
      mergeSpreadTables(prop.getExpression(), sourceFile, project, tables);
    }
  }

  return { tables };
}

function mergeSpreadTables(
  expr: Node,
  sourceFile: SourceFile,
  project: Project,
  tables: Map<string, TableSchema>,
): void {
  if (!Node.isIdentifier(expr)) return;
  const def = findDefinition(expr.getText(), sourceFile, project);
  if (!def || !Node.isObjectLiteralExpression(def.node)) return;
  for (const prop of def.node.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const tableName = propertyName(prop);
    if (!tableName || tables.has(tableName)) continue; // first-writer-wins
    const init = prop.getInitializer();
    if (!init) continue;
    const fields = extractTableFields(init, def.sourceFile, project);
    if (!fields) continue;
    tables.set(tableName, {
      table: tableName,
      fields,
      filePath: def.sourceFile.getFilePath(),
      line: prop.getStartLineNumber(),
    });
  }
}

function findDefineSchemaCall(sourceFile: SourceFile) {
  // Look for default export `export default defineSchema(...)`.
  const exportAssignment = sourceFile.getExportAssignment(() => true);
  if (exportAssignment) {
    const expr = exportAssignment.getExpression();
    if (Node.isCallExpression(expr) && isCallTo(expr, "defineSchema")) {
      return expr;
    }
  }

  // Fallback: any defineSchema(...) call in file.
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isCallTo(call, "defineSchema")) return call;
  }
  return null;
}

function isCallTo(call: Node, name: string): boolean {
  if (!Node.isCallExpression(call)) return false;
  const expr = call.getExpression();
  return expr.getText() === name;
}

/**
 * Extract fields from `defineTable({...}).index(...)` chain. The validator
 * argument may be wrapped in `.index(...)` or `.searchIndex(...)` — walk the
 * call chain to find `defineTable`.
 */
function extractTableFields(
  node: Node,
  sourceFile: SourceFile,
  project: Project,
): Map<string, FieldShape> | null {
  const defineTableCall = findDefineTableCall(node);
  if (!defineTableCall) return null;

  const arg = defineTableCall.getArguments()[0];
  if (!arg) return null;

  const shape = parseValidator(arg);
  const resolved = resolveRef(shape, sourceFile, project);

  if (resolved.kind !== "object") {
    // defineTable might also accept a v.union for discriminated tables —
    // we don't handle that yet. Return empty so it's skipped.
    return null;
  }

  return resolved.fields;
}

function findDefineTableCall(node: Node): Node | null {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isCallExpression(current)) {
      if (isCallTo(current, "defineTable")) return current;
      const expr = current.getExpression();
      if (Node.isPropertyAccessExpression(expr)) {
        // chain like `defineTable(...).index(...)` — recurse left
        current = expr.getExpression();
        continue;
      }
    }
    if (Node.isPropertyAccessExpression(current)) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return null;
}

function propertyName(prop: Node): string | null {
  if (!Node.isPropertyAssignment(prop)) return null;
  const nameNode = prop.getNameNode();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode)) return nameNode.getLiteralValue();
  return null;
}

/**
 * Build the expected return shape for a row from table `T`:
 *   { _id, _creationTime, ...schemaFields }
 */
export function rowShape(table: TableSchema): Shape {
  const fields = new Map<string, FieldShape>();
  fields.set("_id", { shape: { kind: "id", table: table.table }, optional: false });
  fields.set("_creationTime", { shape: { kind: "number" }, optional: false });
  for (const [k, v] of table.fields) fields.set(k, v);
  return { kind: "object", fields };
}
