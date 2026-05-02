import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type FunctionExpression,
  type ReturnStatement,
  type Block,
  type Identifier,
  type CallExpression,
  type Expression,
  type VariableDeclaration,
  type ObjectLiteralExpression,
  type ObjectBindingPattern,
} from "ts-morph";
import { parseValidator } from "./validator.ts";
import type { ReturnIntent, Shape, FieldShape } from "./types.ts";

/**
 * Extra context the scanner can pass: a map from arg name → field shape,
 * derived from the `args:` validator. Used to resolve `args.foo` when
 * `foo` is `v.id("T")`, so `ctx.db.get(args.foo)` becomes rowOf<T>.
 */
export interface AnalyzeContext {
  argsShape?: Map<string, FieldShape>;
}

type HandlerFn = ArrowFunction | FunctionExpression;

/**
 * Analyze every return statement in the handler body, classify each into a
 * ReturnIntent, dedupe, and return.
 */
export function analyzeHandler(handler: HandlerFn, ctx: AnalyzeContext = {}): ReturnIntent[] {
  const body = handler.getBody();
  if (!Node.isBlock(body)) {
    // arrow with expression body
    return [classifyExpression(body, buildScope(handler, ctx))];
  }

  const scope = buildScope(handler, ctx);
  const returns = collectReturnStatements(body);
  const intents: ReturnIntent[] = [];

  if (returns.length === 0) {
    intents.push({ kind: "unanalyzed", reason: "no return statement found" });
    return intents;
  }

  for (const ret of returns) {
    const expr = ret.getExpression();
    if (!expr) {
      intents.push({ kind: "unanalyzed", reason: "bare `return` (undefined)" });
      continue;
    }
    intents.push(classifyExpression(expr, scope));
  }

  return dedupeIntents(intents);
}

interface Scope {
  vars: Map<string, VarInfo>;
  argsShape?: Map<string, FieldShape>;
  argsParamName?: string;
}

interface VarInfo {
  origin: VarOrigin;
  /** keys destructured *out* of this binding (lost from the original row) */
  drop?: Set<string>;
}

type VarOrigin =
  | { kind: "rowOf"; table: string; nullable: boolean }
  | { kind: "rowsOf"; table: string }
  | { kind: "paginatedOf"; table: string }
  | { kind: "literal"; fields: Map<string, Shape> }
  | { kind: "param" }
  | { kind: "unknown"; expr: string };

function buildScope(handler: HandlerFn, ctx: AnalyzeContext): Scope {
  const scope: Scope = { vars: new Map(), argsShape: ctx.argsShape };

  // params: handler signature is `(ctx, args)` — second param is the args object.
  const params = handler.getParameters();
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    scope.vars.set(p.getName(), { origin: { kind: "param" } });
    if (i === 1) scope.argsParamName = p.getName();
  }

  const body = handler.getBody();
  if (!Node.isBlock(body)) return scope;

  // Walk all variable declarations in handler body
  const decls = body.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  for (const decl of decls) {
    bindDeclaration(decl, scope);
  }

  return scope;
}

function bindDeclaration(decl: VariableDeclaration, scope: Scope): void {
  const init = decl.getInitializer();
  if (!init) return;
  const origin = inferOrigin(init, scope);

  const nameNode = decl.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    scope.vars.set(nameNode.getText(), { origin });
    return;
  }

  if (Node.isObjectBindingPattern(nameNode)) {
    // const { a, b, ...rest } = doc;
    // each named element: bind to a fresh var with no provenance (we don't follow leaf field types)
    // rest element: bind to rowOf with `drop` set
    const drops = new Set<string>();
    let restName: string | null = null;
    for (const el of nameNode.getElements()) {
      if (el.getDotDotDotToken()) {
        restName = el.getName();
      } else {
        // pull literal property name (handles renamed: { foo: bar })
        const propName = el.getPropertyNameNode()?.getText() ?? el.getName();
        drops.add(propName);
        scope.vars.set(el.getName(), { origin: { kind: "unknown", expr: el.getText() } });
      }
    }
    if (restName) {
      scope.vars.set(restName, { origin, drop: drops });
    }
  }
}

function inferOrigin(expr: Expression, scope: Scope): VarOrigin {
  // unwrap await
  if (Node.isAwaitExpression(expr)) {
    return inferOrigin(expr.getExpression(), scope);
  }

  // identifier reference — look up in scope
  if (Node.isIdentifier(expr)) {
    const v = scope.vars.get(expr.getText());
    if (v) return v.origin;
    return { kind: "unknown", expr: expr.getText() };
  }

  // call chains: ctx.db.get(id) / ctx.db.query("T").<...>.first()/.unique()/.collect()/.paginate()
  if (Node.isCallExpression(expr)) {
    return originFromCall(expr, scope);
  }

  // object literal
  if (Node.isObjectLiteralExpression(expr)) {
    return { kind: "literal", fields: literalFields(expr, scope) };
  }

  // ?? null fallback: `await ctx.db.get(id) ?? null` → still nullable rowOf
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === "??" || op === "||") {
      const left = inferOrigin(expr.getLeft(), scope);
      // if right is null literal, just return left (already nullable for get)
      if (left.kind === "rowOf") return { ...left, nullable: true };
      return left;
    }
  }

  return { kind: "unknown", expr: expr.getText().slice(0, 80) };
}

function originFromCall(call: CallExpression, scope: Scope): VarOrigin {
  const expr = call.getExpression();

  // Map / paginate end-call: catch top-level then descend
  if (Node.isPropertyAccessExpression(expr)) {
    const method = expr.getName();
    const receiver = expr.getExpression();

    // ctx.db.get(id) — rowOf table inferred from id arg
    if (method === "get" && receiverText(receiver) === "ctx.db") {
      const idArg = call.getArguments()[0];
      const table = idArg ? inferTableFromIdArg(idArg, scope) : null;
      return { kind: "rowOf", table: table ?? "<unknown>", nullable: true };
    }

    // ctx.db.query("T")...<terminal>
    const queryTable = findQueryTable(call);
    if (queryTable) {
      switch (method) {
        case "first":
        case "unique":
          return { kind: "rowOf", table: queryTable, nullable: true };
        case "collect":
        case "take":
          return { kind: "rowsOf", table: queryTable };
        case "paginate":
          return { kind: "paginatedOf", table: queryTable };
      }
    }

    // .map(...) on rows or paginated.page
    if (method === "map") {
      const recvOrigin = inferOrigin(receiver, scope);
      // map preserves cardinality
      return recvOrigin;
    }

    // ctx.db.normalizeId / .system.* / etc — give up
    return { kind: "unknown", expr: call.getText().slice(0, 80) };
  }

  return { kind: "unknown", expr: call.getText().slice(0, 80) };
}

/** Walk left through `.foo().bar().baz()` chain looking for `.query("T")`. */
function findQueryTable(call: CallExpression): string | null {
  let current: Node = call;
  while (current) {
    if (Node.isCallExpression(current)) {
      const e = current.getExpression();
      if (Node.isPropertyAccessExpression(e)) {
        if (e.getName() === "query" && receiverText(e.getExpression()) === "ctx.db") {
          const arg = current.getArguments()[0];
          if (arg && Node.isStringLiteral(arg)) return arg.getLiteralValue();
          return null;
        }
        current = e.getExpression();
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

function receiverText(node: Node): string {
  return node.getText().replace(/\s+/g, "");
}

function inferTableFromIdArg(arg: Node, scope: Scope): string | null {
  // case: `args.foo` where args validator declares foo as v.id("T")
  if (Node.isPropertyAccessExpression(arg)) {
    const recv = arg.getExpression();
    if (
      Node.isIdentifier(recv) &&
      scope.argsParamName === recv.getText() &&
      scope.argsShape
    ) {
      const fieldName = arg.getName();
      const fs = scope.argsShape.get(fieldName);
      if (fs && fs.shape.kind === "id") return fs.shape.table;
    }
  }
  return null;
}

function literalFields(obj: ObjectLiteralExpression, scope: Scope): Map<string, Shape> {
  const fields = new Map<string, Shape>();
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = propAssignName(prop);
      if (!name) continue;
      // We don't infer leaf types — just record presence.
      fields.set(name, { kind: "any" });
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      fields.set(prop.getName(), { kind: "any" });
    } else if (Node.isSpreadAssignment(prop)) {
      const sub = prop.getExpression();
      const origin = inferOrigin(sub, scope);
      // For a spread, mark synthetic key `__spread:<originDesc>`
      const desc = describeOrigin(origin);
      fields.set(`__spread:${desc}`, { kind: "any" });
    }
  }
  return fields;
}

function propAssignName(prop: Node): string | null {
  if (!Node.isPropertyAssignment(prop)) return null;
  const n = prop.getNameNode();
  if (Node.isIdentifier(n)) return n.getText();
  if (Node.isStringLiteral(n)) return n.getLiteralValue();
  return null;
}

function describeOrigin(o: VarOrigin): string {
  switch (o.kind) {
    case "rowOf":
      return `row<${o.table}>`;
    case "rowsOf":
      return `rows<${o.table}>`;
    case "paginatedOf":
      return `paginated<${o.table}>`;
    case "literal":
      return "literal";
    case "param":
      return "param";
    default:
      return "unknown";
  }
}

function classifyExpression(expr: Expression | Block, scope: Scope): ReturnIntent {
  if (Node.isBlock(expr)) {
    return { kind: "unanalyzed", reason: "block expression body" };
  }

  // null / undefined
  if (expr.getKind() === SyntaxKind.NullKeyword) return { kind: "null" };
  if (Node.isIdentifier(expr) && expr.getText() === "undefined") return { kind: "null" };

  // primitive literals
  if (Node.isStringLiteral(expr)) return { kind: "primitive", primitive: "string" };
  if (Node.isNumericLiteral(expr)) return { kind: "primitive", primitive: "number" };
  if (expr.getKind() === SyntaxKind.TrueKeyword || expr.getKind() === SyntaxKind.FalseKeyword) {
    return { kind: "primitive", primitive: "boolean" };
  }

  // Array literal `[...]` — treat as literalArray of first element
  if (Node.isArrayLiteralExpression(expr)) {
    const first = expr.getElements()[0];
    if (!first) return { kind: "unanalyzed", reason: "empty array literal" };
    return { kind: "literalArray", element: classifyExpression(first as Expression, scope) };
  }

  // ?? null fallback
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === "??" || op === "||") {
      const left = classifyExpression(expr.getLeft() as Expression, scope);
      const right = expr.getRight();
      const isNullRight =
        right.getKind() === SyntaxKind.NullKeyword ||
        (Node.isIdentifier(right) && right.getText() === "undefined");
      if (left.kind === "row" && isNullRight) {
        return { ...left, nullable: true };
      }
      return left;
    }
  }

  // Conditional: ternary — collect both branches
  if (Node.isConditionalExpression(expr)) {
    return classifyExpression(expr.getWhenTrue() as Expression, scope);
  }

  // Identifier — look up in scope
  if (Node.isIdentifier(expr)) {
    return classifyVar(expr.getText(), scope);
  }

  // await
  if (Node.isAwaitExpression(expr)) {
    return classifyExpression(expr.getExpression(), scope);
  }

  // call (e.g. await ctx.db.get(id)): wrap as origin
  if (Node.isCallExpression(expr)) {
    const origin = inferOrigin(expr, scope);
    return originToIntent(origin, new Set(), new Map());
  }

  // object literal
  if (Node.isObjectLiteralExpression(expr)) {
    return classifyObjectLiteral(expr, scope);
  }

  return { kind: "unanalyzed", reason: `unsupported return expr: ${expr.getKindName()}` };
}

function classifyVar(name: string, scope: Scope): ReturnIntent {
  const info = scope.vars.get(name);
  if (!info) return { kind: "unanalyzed", reason: `unknown identifier ${name}` };
  return originToIntent(info.origin, info.drop ?? new Set(), new Map());
}

function originToIntent(
  origin: VarOrigin,
  drop: Set<string>,
  add: Map<string, Shape>,
): ReturnIntent {
  switch (origin.kind) {
    case "rowOf":
      return { kind: "row", table: origin.table, drop, add, nullable: origin.nullable };
    case "rowsOf":
      return { kind: "rows", table: origin.table, drop, add };
    case "paginatedOf":
      return { kind: "paginated", table: origin.table, drop, add };
    case "literal":
      return { kind: "literal", fields: origin.fields };
    case "param":
      return { kind: "unanalyzed", reason: "returning a parameter" };
    default:
      return { kind: "unanalyzed", reason: `returning ${origin.expr ?? "unknown"}` };
  }
}

function classifyObjectLiteral(obj: ObjectLiteralExpression, scope: Scope): ReturnIntent {
  // Detect single-spread + extras: `{ ...row, extra: x }`
  let baseOrigin: VarOrigin | null = null;
  let baseDrop = new Set<string>();
  const literalFieldsMap = new Map<string, Shape>();

  for (const prop of obj.getProperties()) {
    if (Node.isSpreadAssignment(prop)) {
      const sub = prop.getExpression();
      const origin = inferOrigin(sub, scope);
      // if the spread is an identifier with drops, pick up its drop set
      if (Node.isIdentifier(sub)) {
        const info = scope.vars.get(sub.getText());
        if (info?.drop) baseDrop = info.drop;
      }
      if (baseOrigin) {
        // multiple spreads — too dynamic, fall back
        return { kind: "unanalyzed", reason: "multiple spreads in return literal" };
      }
      baseOrigin = origin;
    } else if (Node.isPropertyAssignment(prop)) {
      const name = propAssignName(prop);
      if (name) literalFieldsMap.set(name, { kind: "any" });
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      literalFieldsMap.set(prop.getName(), { kind: "any" });
    }
  }

  if (baseOrigin) {
    return originToIntent(baseOrigin, baseDrop, literalFieldsMap);
  }

  // Pure literal
  return { kind: "literal", fields: literalFieldsMap };
}

function collectReturnStatements(block: Block): ReturnStatement[] {
  return block.getDescendantsOfKind(SyntaxKind.ReturnStatement);
}

function dedupeIntents(intents: ReturnIntent[]): ReturnIntent[] {
  const seen = new Set<string>();
  const out: ReturnIntent[] = [];
  for (const i of intents) {
    const key = JSON.stringify(i, (k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}
