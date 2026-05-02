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

  if (Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
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
      if (!arg || !Node.isObjectLiteralExpression(arg)) {
        return { kind: "unknown", reason: "v.object expected object literal" };
      }
      return parseObjectLiteral(arg, depth);
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
      fields.set(name, unwrapOptional(shape));
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      // shorthand value: { foo } — treat as ref
      const name = prop.getName();
      fields.set(name, { shape: { kind: "ref", symbol: name }, optional: false });
    } else if (Node.isSpreadAssignment(prop)) {
      // spread of another validator object — record as ref under synthetic key
      const exprText = prop.getExpression().getText();
      fields.set(`__spread:${exprText}`, {
        shape: { kind: "ref", symbol: exprText },
        optional: false,
      });
    }
  }

  return { kind: "object", fields };
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
      const next = new Map(shape.fields);
      for (const [k, v] of next) {
        const r = resolveRef(v.shape, sourceFile, project, seen);
        next.set(k, { shape: r, optional: v.optional });
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

function findDefinition(
  symbol: string,
  sourceFile: SourceFile,
  project: Project,
): { node: Node; sourceFile: SourceFile } | null {
  // local file
  const local = sourceFile.getVariableDeclaration(symbol);
  if (local) {
    const init = local.getInitializer();
    if (init) return { node: init, sourceFile };
  }

  // imports
  for (const imp of sourceFile.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => n.getName() === symbol);
    if (!named) continue;
    const moduleSpec = imp.getModuleSpecifierValue();
    const target = project
      .getSourceFiles()
      .find((sf) => moduleResolves(sourceFile.getFilePath(), moduleSpec, sf.getFilePath()));
    if (!target) continue;
    const decl = target.getVariableDeclaration(symbol);
    if (decl) {
      const init = decl.getInitializer();
      if (init) return { node: init, sourceFile: target };
    }
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
