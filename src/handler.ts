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
  /**
   * Resolve `ctx.runQuery(internal.x.y, ...)` to the called function's
   * returns shape. Segments are the path after `internal`/`api` —
   * `internal.charges.queries.list` → `["charges", "queries", "list"]`.
   * The last segment is the export name; the rest is the file path.
   */
  resolveRunCall?: (segments: string[]) => Shape | null;
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
    for (const branch of expandConditionals(expr)) {
      intents.push(classifyExpression(branch, scope));
    }
  }

  return dedupeIntents(intents);
}

/**
 * Expand top-level ternaries into one expression per branch. Recurses so
 * that `a ? b : (c ? d : e)` yields `[b, d, e]`.
 */
function expandConditionals(expr: Expression): Expression[] {
  if (Node.isConditionalExpression(expr)) {
    return [
      ...expandConditionals(expr.getWhenTrue() as Expression),
      ...expandConditionals(expr.getWhenFalse() as Expression),
    ];
  }
  return [expr];
}

interface Scope {
  vars: Map<string, VarInfo>;
  argsShape?: Map<string, FieldShape>;
  argsParamName?: string;
  resolveRunCall?: (segments: string[]) => Shape | null;
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
  | { kind: "literalArrayOf"; element: ReturnIntent }
  | { kind: "idOf"; table: string }
  | { kind: "param" }
  | { kind: "unknown"; expr: string };

function buildScope(handler: HandlerFn, ctx: AnalyzeContext): Scope {
  const scope: Scope = {
    vars: new Map(),
    argsShape: ctx.argsShape,
    resolveRunCall: ctx.resolveRunCall,
  };

  // params: handler signature is `(ctx, args)` — second param is the args object.
  const params = handler.getParameters();
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    scope.vars.set(p.getName(), { origin: { kind: "param" } });
    if (i === 1) scope.argsParamName = p.getName();
  }

  const body = handler.getBody();
  if (!Node.isBlock(body)) return scope;

  // Walk variable declarations in *this* function body — skip nested callbacks
  // so their locals don't shadow handler-scoped names.
  const decls = collectOwnVariableDeclarations(body);
  for (const decl of decls) {
    bindDeclaration(decl, scope);
  }

  return scope;
}

function collectOwnVariableDeclarations(block: Block): VariableDeclaration[] {
  const out: VariableDeclaration[] = [];
  function visit(node: Node): void {
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node)
    ) {
      return;
    }
    if (Node.isVariableDeclaration(node)) out.push(node);
    node.forEachChild(visit);
  }
  block.forEachChild(visit);
  return out;
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

  // args.X where X is v.id("T") in argsShape → idOf
  if (Node.isPropertyAccessExpression(expr)) {
    const recv = expr.getExpression();
    if (
      Node.isIdentifier(recv) &&
      scope.argsParamName === recv.getText() &&
      scope.argsShape
    ) {
      const fs = scope.argsShape.get(expr.getName());
      if (fs && fs.shape.kind === "id") {
        return { kind: "idOf", table: fs.shape.table };
      }
    }
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

    // .map(...) — trace the callback body so we don't incorrectly inherit
    // rows<T> when the callback transforms the row shape.
    if (method === "map") {
      const mapped = tryClassifyMapCall(call, scope);
      if (mapped && mapped.kind === "literalArray") {
        return { kind: "literalArrayOf", element: mapped.element };
      }
      // Fallback: if the callback didn't classify (e.g. inline lambda body
      // we can't follow), preserve receiver's cardinality so downstream
      // code at least knows it's an array.
      return inferOrigin(receiver, scope);
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
  // case: `id` where `const id = args.foo` was bound earlier
  if (Node.isIdentifier(arg)) {
    const v = scope.vars.get(arg.getText());
    if (v && v.origin.kind === "idOf") return v.origin.table;
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
    case "literalArrayOf":
      return "literalArray";
    case "idOf":
      return `id<${o.table}>`;
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

  // unwrap parens, `as const`, `as T`, type assertions
  if (Node.isParenthesizedExpression(expr)) {
    return classifyExpression(expr.getExpression(), scope);
  }
  if (Node.isAsExpression(expr) || Node.isTypeAssertion(expr)) {
    return classifyExpression(expr.getExpression(), scope);
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
    // Special: `ctx.runQuery/runMutation/runAction(internal.x.y, ...)` —
    // resolve the called function's returns shape.
    const ran = tryClassifyRunCall(expr, scope);
    if (ran) return ran;
    // Special: `Promise.all(<iterable>)` preserves the element shape.
    // Recurse into the argument.
    const promised = tryClassifyPromiseAll(expr, scope);
    if (promised) return promised;
    // Special: `arr.map(callback)` — trace callback body so we don't
    // incorrectly inherit rows<T> when the callback transforms the row.
    const mapped = tryClassifyMapCall(expr, scope);
    if (mapped) return mapped;
    const origin = inferOrigin(expr, scope);
    return originToIntent(origin, new Set(), new Map());
  }

  // object literal
  if (Node.isObjectLiteralExpression(expr)) {
    return classifyObjectLiteral(expr, scope);
  }

  return { kind: "unanalyzed", reason: `unsupported return expr: ${expr.getKindName()}` };
}

/**
 * Handle `<arr>.map(arrowFn)` directly — recurse into the callback body and
 * wrap as `literalArray`. Returns null if `call` isn't a `.map` call.
 */
function tryClassifyMapCall(call: CallExpression, scope: Scope): ReturnIntent | null {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "map") return null;
  const arg = call.getArguments()[0];
  if (!arg) return null;
  if (!Node.isArrowFunction(arg) && !Node.isFunctionExpression(arg)) return null;

  // Build sub-scope: bind callback param to row<T> if receiver is rows<T>.
  const subScope: Scope = {
    vars: new Map(scope.vars),
    argsShape: scope.argsShape,
    argsParamName: scope.argsParamName,
    resolveRunCall: scope.resolveRunCall,
  };
  const receiverOrigin = inferOrigin(expr.getExpression(), scope);
  const params = arg.getParameters();
  if (params[0]) {
    const elementOrigin = elementOriginOf(receiverOrigin);
    if (elementOrigin) {
      const nameNode = params[0].getNameNode();
      if (Node.isIdentifier(nameNode)) {
        subScope.vars.set(nameNode.getText(), { origin: elementOrigin });
      }
    }
  }

  const body = arg.getBody();
  let elementIntent: ReturnIntent;
  if (Node.isBlock(body)) {
    const rets = collectReturnStatements(body);
    const first = rets[0]?.getExpression();
    if (!first) return null;
    elementIntent = classifyExpression(first, subScope);
  } else {
    elementIntent = classifyExpression(body as Expression, subScope);
  }

  return { kind: "literalArray", element: elementIntent };
}

/**
 * Detect `ctx.runQuery(internal.x.y, ...)` etc. and resolve to the called
 * function's returns shape via the AnalyzeContext resolver. Returns null
 * for non-runX calls or when the target reference isn't `internal.*`/`api.*`.
 */
function tryClassifyRunCall(call: CallExpression, scope: Scope): ReturnIntent | null {
  if (!scope.resolveRunCall) return null;
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;
  const method = expr.getName();
  if (method !== "runQuery" && method !== "runMutation" && method !== "runAction") return null;
  if (receiverText(expr.getExpression()) !== "ctx") return null;

  const target = call.getArguments()[0];
  if (!target) return null;
  const segments = readApiSegments(target);
  if (!segments || segments.length === 0) return null;

  const shape = scope.resolveRunCall(segments);
  if (!shape) return null;
  return { kind: "passthrough", shape, from: segments.join(".") };
}

/**
 * `Promise.all(<expr>)` preserves array shape — recurse into `<expr>`.
 * Returns null for non-Promise.all calls.
 */
function tryClassifyPromiseAll(call: CallExpression, scope: Scope): ReturnIntent | null {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;
  if (expr.getName() !== "all") return null;
  const recv = expr.getExpression();
  if (!Node.isIdentifier(recv) || recv.getText() !== "Promise") return null;

  const arg = call.getArguments()[0];
  if (!arg) return null;
  return classifyExpression(arg as Expression, scope);
}

function readApiSegments(node: Node): string[] | null {
  const parts: string[] = [];
  let current: Node = node;
  while (Node.isPropertyAccessExpression(current)) {
    parts.unshift(current.getName());
    current = current.getExpression();
  }
  if (!Node.isIdentifier(current)) return null;
  const root = current.getText();
  if (root !== "internal" && root !== "api") return null;
  return parts;
}

function elementOriginOf(o: VarOrigin): VarOrigin | null {
  if (o.kind === "rowsOf") return { kind: "rowOf", table: o.table, nullable: false };
  if (o.kind === "paginatedOf") return { kind: "rowOf", table: o.table, nullable: false };
  return null;
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
    case "literalArrayOf":
      return { kind: "literalArray", element: origin.element };
    case "idOf":
      return { kind: "unanalyzed", reason: `returning bare id<${origin.table}>` };
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
      if (!name) continue;
      const init = prop.getInitializer();
      literalFieldsMap.set(name, init ? literalShapeOf(init) : { kind: "any" });
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

/**
 * Best-effort: read a literal value from an initializer expression.
 * Used to capture discriminator values like `ok: true as const` so the
 * matcher can score-match union branches.
 */
function literalShapeOf(node: Node): Shape {
  let n: Node = node;
  // unwrap `<expr> as const` and `<expr> as T`
  while (Node.isAsExpression(n) || Node.isTypeAssertion(n)) {
    n = n.getExpression();
  }
  if (Node.isStringLiteral(n)) return { kind: "literal", value: n.getLiteralValue() };
  if (Node.isNumericLiteral(n)) return { kind: "literal", value: Number(n.getLiteralValue()) };
  if (n.getKind() === SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
  if (n.getKind() === SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
  return { kind: "any" };
}

function collectReturnStatements(block: Block): ReturnStatement[] {
  // Only collect returns belonging to *this* function — never descend into
  // nested arrow / function expressions / function declarations, since their
  // returns belong to those callbacks, not to the handler.
  const out: ReturnStatement[] = [];
  function visit(node: Node): void {
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node)
    ) {
      return;
    }
    if (Node.isReturnStatement(node)) {
      out.push(node);
    }
    node.forEachChild(visit);
  }
  block.forEachChild(visit);
  return out;
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
