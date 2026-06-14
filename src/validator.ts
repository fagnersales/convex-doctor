import {
  Node,
  CallExpression,
  ObjectLiteralExpression,
  PropertyAssignment,
  Identifier,
  SyntaxKind,
  SourceFile,
  type Project,
} from "ts-morph";
import type { Shape, FieldShape } from "./types.ts";

/**
 * Parse a v.* validator expression into a Shape ADT.
 *
 * Recognized forms (mirroring `convex/values`):
 *  - v.string() / v.number() / v.boolean() / v.null() / v.bytes() / v.int64() / v.any()
 *  - v.id("table")
 *  - v.literal("x") / v.literal(123) / v.literal(true)
 *  - v.optional(inner)
 *  - v.array(element)
 *  - v.union(a, b, ...)
 *  - v.record(keyShape, valueShape)
 *  - v.object({ key: shape, ... })
 *  - identifier reference → ref shape (resolved later via cross-file lookup)
 */
export function parseValidator(node: Node, depth = 0): Shape {
  if (depth > 32) return { kind: "unknown", reason: "depth limit exceeded" };

  if (Node.isParenthesizedExpression(node)) {
    return parseValidator(node.getExpression(), depth + 1);
  }

  if (
    Node.isAsExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isSatisfiesExpression(node)
  ) {
    return parseValidator(node.getExpression(), depth + 1);
  }

  if (Node.isCallExpression(node)) {
    return parseCallValidator(node, depth);
  }

  // Bare object literal — Convex args notation: `args: { name: v.string() }`.
  // Treat as v.object({...}) shorthand.
  if (Node.isObjectLiteralExpression(node)) {
    return parseObjectLiteral(node, depth);
  }

  if (Node.isIdentifier(node)) {
    return { kind: "ref", symbol: node.getText() };
  }

  if (Node.isPropertyAccessExpression(node)) {
    // bare `v.something` not invoked — treat as ref
    return { kind: "ref", symbol: node.getText() };
  }

  return { kind: "unknown", reason: `unsupported node: ${node.getKindName()}` };
}

function parseCallValidator(call: CallExpression, depth: number): Shape {
  const expr = call.getExpression();
  const args = call.getArguments();

  // expr should be a property access like `v.string`
  if (!Node.isPropertyAccessExpression(expr)) {
    // could be a helper call returning a validator (e.g. `customId("foo")`)
    return { kind: "unknown", reason: `non-v call: ${expr.getText()}` };
  }

  const method = expr.getName();
  switch (method) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "null":
      return { kind: "null" };
    case "bytes":
      return { kind: "bytes" };
    case "int64":
      return { kind: "int64" };
    case "any":
      return { kind: "any" };
    case "id": {
      const arg = args[0];
      const tableName =
        arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : "<unknown>";
      return { kind: "id", table: tableName };
    }
    case "literal": {
      const arg = args[0];
      if (!arg) return { kind: "unknown", reason: "v.literal missing arg" };
      if (Node.isStringLiteral(arg)) return { kind: "literal", value: arg.getLiteralValue() };
      if (Node.isNumericLiteral(arg)) return { kind: "literal", value: Number(arg.getLiteralValue()) };
      if (arg.getKind() === SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
      if (arg.getKind() === SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
      return { kind: "unknown", reason: `v.literal non-literal arg` };
    }
    case "optional": {
      const arg = args[0];
      if (!arg) return { kind: "unknown", reason: "v.optional missing arg" };
      return { kind: "optional", inner: parseValidator(arg, depth + 1) };
    }
    case "array": {
      const arg = args[0];
      if (!arg) return { kind: "unknown", reason: "v.array missing arg" };
      return { kind: "array", element: parseValidator(arg, depth + 1) };
    }
    case "record": {
      const [k, v] = args;
      if (!k || !v) return { kind: "unknown", reason: "v.record missing args" };
      return {
        kind: "record",
        key: parseValidator(k, depth + 1),
        value: parseValidator(v, depth + 1),
      };
    }
    case "union": {
      return {
        kind: "union",
        members: args.map((a) => parseValidator(a, depth + 1)),
      };
    }
    case "object": {
      const arg = args[0];
      if (!arg) return { kind: "unknown", reason: "v.object missing arg" };
      if (Node.isObjectLiteralExpression(arg)) return parseObjectLiteral(arg, depth);
      if (Node.isIdentifier(arg)) {
        // `v.object(someConst)` where someConst is a plain object literal of v.* fields
        return { kind: "ref", symbol: arg.getText() };
      }
      return { kind: "unknown", reason: "v.object expected object literal or identifier" };
    }
    default:
      return { kind: "unknown", reason: `unknown v.${method}` };
  }
}

function parseObjectLiteral(obj: ObjectLiteralExpression, depth: number): Shape {
  const fields = new Map<string, FieldShape>();

  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = propertyName(prop);
      if (!name) continue;
      const init = prop.getInitializer();
      if (!init) continue;
      const shape = parseValidator(init, depth + 1);
      fields.set(name, { ...unwrapOptional(shape), loc: locOf(prop) });
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      // shorthand value: { foo } — treat as ref
      const name = prop.getName();
      fields.set(name, { shape: { kind: "ref", symbol: name }, optional: false, loc: locOf(prop) });
    } else if (Node.isSpreadAssignment(prop)) {
      // spread of another validator/object — resolve at resolveNested time.
      // Two patterns to handle:
      //   { ...baseFields }              → spread of plain object literal
      //   { ...baseValidator.fields }    → spread of v.object(...).fields
      const expr = prop.getExpression();
      const exprText = expr.getText();
      let baseSymbol = exprText;
      if (Node.isPropertyAccessExpression(expr) && expr.getName() === "fields") {
        baseSymbol = expr.getExpression().getText();
      }
      fields.set(`__spread:${exprText}`, {
        shape: { kind: "ref", symbol: baseSymbol },
        optional: false,
      });
    }
  }

  return { kind: "object", fields };
}

function locOf(prop: Node): FieldShape["loc"] {
  return {
    line: prop.getStartLineNumber(),
    column: prop.getStart() - prop.getStartLinePos(),
    text: prop.getText(),
  };
}

function propertyName(prop: PropertyAssignment): string | null {
  const nameNode = prop.getNameNode();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode)) return nameNode.getLiteralValue();
  if (Node.isNumericLiteral(nameNode)) return nameNode.getText();
  if (Node.isComputedPropertyName(nameNode)) return null;
  return null;
}

function unwrapOptional(shape: Shape): FieldShape {
  if (shape.kind === "optional") {
    return { shape: shape.inner, optional: true };
  }
  return { shape, optional: false };
}

/**
 * Resolve a `ref` shape by following an identifier symbol to its definition.
 * If the definition is `export const X = v.object({...})`, parse that.
 * Recursive refs are guarded via a `seen` set.
 */
export function resolveRef(
  shape: Shape,
  sourceFile: SourceFile,
  project: Project,
  seen = new Set<string>(),
): Shape {
  if (shape.kind !== "ref") return resolveNested(shape, sourceFile, project, seen);
  if (seen.has(shape.symbol)) return shape; // cycle
  seen.add(shape.symbol);

  const def = findDefinition(shape.symbol, sourceFile, project);
  if (!def) return shape;
  const parsed = parseValidator(def.node);
  shape.resolved = resolveNested(parsed, def.sourceFile, project, seen);
  // `seen` is an *active-path* stack, not a global visited-set: pop after
  // resolving so a validator referenced by two sibling fields (a diamond)
  // resolves in both, while true cycles still trip the guard above (C9).
  seen.delete(shape.symbol);
  return shape.resolved;
}

function resolveNested(
  shape: Shape,
  sourceFile: SourceFile,
  project: Project,
  seen: Set<string>,
): Shape {
  switch (shape.kind) {
    case "object": {
      const next = new Map<string, FieldShape>();
      for (const [k, v] of shape.fields) {
        if (k.startsWith("__spread:")) {
          // Try to inline the spread's resolved object fields.
          const resolved = resolveRef(v.shape, sourceFile, project, seen);
          if (resolved.kind === "object") {
            for (const [sk, sv] of resolved.fields) {
              if (sk.startsWith("__spread:")) {
                // nested unresolved spread bubbles up
                if (!next.has(sk)) next.set(sk, sv);
              } else if (!next.has(sk)) {
                next.set(sk, sv);
              }
            }
          } else {
            // unresolved — keep marker so match.ts can suppress noise
            next.set(k, v);
          }
          continue;
        }
        const r = resolveRef(v.shape, sourceFile, project, seen);
        next.set(k, { shape: r, optional: v.optional, loc: v.loc });
      }
      return { ...shape, fields: next };
    }
    case "array":
      return { ...shape, element: resolveRef(shape.element, sourceFile, project, seen) };
    case "optional":
      return { ...shape, inner: resolveRef(shape.inner, sourceFile, project, seen) };
    case "union":
      return {
        ...shape,
        members: shape.members.map((m) => resolveRef(m, sourceFile, project, seen)),
      };
    case "record":
      return {
        ...shape,
        key: resolveRef(shape.key, sourceFile, project, seen),
        value: resolveRef(shape.value, sourceFile, project, seen),
      };
    default:
      return shape;
  }
}

/**
 * Resolve an identifier to its definition node (initializer expression),
 * following local declarations, imports, and re-export barrels. Exported for
 * the schema parser, which needs to inline `...sharedTables` spreads.
 */
export function findDefinition(
  symbol: string,
  sourceFile: SourceFile,
  project: Project,
): { node: Node; sourceFile: SourceFile } | null {
  return findInFile(symbol, sourceFile, project, new Set());
}

/**
 * Look up `symbol` in `sourceFile`, following imports and re-exports.
 * Cycle-safe via `visited` set of file paths.
 */
function findInFile(
  symbol: string,
  sourceFile: SourceFile,
  project: Project,
  visited: Set<string>,
): { node: Node; sourceFile: SourceFile } | null {
  const filePath = sourceFile.getFilePath();
  if (visited.has(filePath)) return null;
  visited.add(filePath);

  // local definition
  const local = sourceFile.getVariableDeclaration(symbol);
  if (local) {
    const init = local.getInitializer();
    if (init) return { node: init, sourceFile };
  }

  // re-exports: `export { x } from "./y"` or `export { x as y } from "./z"`
  for (const exp of sourceFile.getExportDeclarations()) {
    const moduleSpec = exp.getModuleSpecifierValue();
    if (!moduleSpec) continue;
    for (const named of exp.getNamedExports()) {
      const aliasNode = named.getAliasNode();
      const exportedName = aliasNode ? aliasNode.getText() : named.getName();
      if (exportedName !== symbol) continue;
      const sourceName = named.getName();
      const target = project
        .getSourceFiles()
        .find((sf) => moduleResolves(filePath, moduleSpec, sf.getFilePath()));
      if (!target) continue;
      const result = findInFile(sourceName, target, project, visited);
      if (result) return result;
    }
  }

  // imports: `import { x } from "./y"` — recurse into target file
  for (const imp of sourceFile.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => {
      const aliasNode = n.getAliasNode();
      const localName = aliasNode ? aliasNode.getText() : n.getName();
      return localName === symbol;
    });
    if (!named) continue;
    const moduleSpec = imp.getModuleSpecifierValue();
    const target = project
      .getSourceFiles()
      .find((sf) => moduleResolves(filePath, moduleSpec, sf.getFilePath()));
    if (!target) continue;
    const sourceName = named.getName();
    const result = findInFile(sourceName, target, project, visited);
    if (result) return result;
  }

  return null;
}

function moduleResolves(fromPath: string, spec: string, candidatePath: string): boolean {
  if (!spec.startsWith(".")) return false;
  // strip extension on candidate
  const cand = candidatePath.replace(/\.(ts|tsx|js|jsx)$/, "");
  // resolve relative path
  const fromDir = fromPath.replace(/\/[^/]+$/, "");
  const joined = normalize(`${fromDir}/${spec}`);
  return cand === joined || cand === `${joined}/index`;
}

function normalize(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/");
}

/**
 * Render a Shape back into Convex validator source (`v.string()`, `v.id("t")`,
 * `v.object({...})`, …) for copy-pasteable fix suggestions.
 *
 * Returns `null` when the shape (or any sub-shape) is an unresolved `ref` or
 * `unknown` — we must never emit `v.ref()` / `v.unknown()` garbage. `opts.optional`
 * wraps the result in `v.optional(...)`.
 */
export function shapeToValidatorSource(
  shape: Shape,
  opts: { optional?: boolean } = {},
): string | null {
  const inner = renderShape(shape);
  if (inner === null) return null;
  return opts.optional ? `v.optional(${inner})` : inner;
}

function renderShape(shape: Shape): string | null {
  switch (shape.kind) {
    case "any":
      return "v.any()";
    case "null":
      return "v.null()";
    case "string":
      return "v.string()";
    case "number":
      return "v.number()";
    case "int64":
      return "v.int64()";
    case "boolean":
      return "v.boolean()";
    case "bytes":
      return "v.bytes()";
    case "literal":
      return `v.literal(${JSON.stringify(shape.value)})`;
    case "id":
      return `v.id(${JSON.stringify(shape.table)})`;
    case "array": {
      const el = renderShape(shape.element);
      return el === null ? null : `v.array(${el})`;
    }
    case "record": {
      const k = renderShape(shape.key);
      const v = renderShape(shape.value);
      return k === null || v === null ? null : `v.record(${k}, ${v})`;
    }
    case "optional": {
      const i = renderShape(shape.inner);
      return i === null ? null : `v.optional(${i})`;
    }
    case "union": {
      const parts = shape.members.map(renderShape);
      if (parts.some((p) => p === null)) return null;
      return `v.union(${parts.join(", ")})`;
    }
    case "object": {
      const parts: string[] = [];
      for (const [k, fs] of shape.fields) {
        if (k.startsWith("__spread:")) return null; // unresolved spread
        const rendered = renderShape(fs.shape);
        if (rendered === null) return null;
        const value = fs.optional ? `v.optional(${rendered})` : rendered;
        parts.push(`${k}: ${value}`);
      }
      return `v.object({ ${parts.join(", ")} })`;
    }
    // ref / unknown — can't render safely.
    default:
      return null;
  }
}

/**
 * Walk a Shape tree. Used for diffing.
 */
export function shapeToString(shape: Shape, indent = 0): string {
  const pad = "  ".repeat(indent);
  switch (shape.kind) {
    case "object": {
      const lines = [`${pad}{`];
      for (const [k, v] of shape.fields) {
        lines.push(`${pad}  ${k}${v.optional ? "?" : ""}: ${shapeToString(v.shape, indent + 1).trimStart()}`);
      }
      lines.push(`${pad}}`);
      return lines.join("\n");
    }
    case "array":
      return `${pad}${shapeToString(shape.element, 0).trimStart()}[]`;
    case "union":
      return `${pad}(${shape.members.map((m) => shapeToString(m, 0).trimStart()).join(" | ")})`;
    case "optional":
      return `${pad}${shapeToString(shape.inner, 0).trimStart()}?`;
    case "id":
      return `${pad}id<${shape.table}>`;
    case "literal":
      return `${pad}${JSON.stringify(shape.value)}`;
    case "ref":
      return `${pad}ref<${shape.symbol}>`;
    case "record":
      return `${pad}Record<${shapeToString(shape.key, 0).trimStart()}, ${shapeToString(shape.value, 0).trimStart()}>`;
    default:
      return `${pad}${shape.kind}`;
  }
}
