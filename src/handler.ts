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
import { rowShape } from "./schema.ts";
import type { ReturnIntent, Shape, FieldShape, SchemaModel } from "./types.ts";

/**
 * Extra context the scanner can pass: a map from arg name → field shape,
 * derived from the `args:` validator. Used to resolve `args.foo` when
 * `foo` is `v.id("T")`, so `ctx.db.get(args.foo)` becomes rowOf<T>.
 */
export interface AnalyzeContext {
  argsShape?: Map<string, FieldShape>;
  /** Schema model — used to resolve `<rowOf<T>>.fieldName` to the field's
   *  shape so `return charge._id` etc. classify correctly. */
  schema?: SchemaModel;
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
  // Unwrap parens / casts so a wrapped ternary (`=> (cond ? a : b)`) still
  // expands into both branches.
  if (Node.isParenthesizedExpression(expr)) {
    return expandConditionals(expr.getExpression() as Expression);
  }
  if (Node.isAsExpression(expr) || Node.isTypeAssertion(expr)) {
    return expandConditionals(expr.getExpression() as Expression);
  }
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
  schema?: SchemaModel;
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
  | { kind: "literalArrayOf"; element: ReturnIntent; elements?: ReturnIntent[] }
  | { kind: "idOf"; table: string }
  /** Value-of-id — ctx.db.insert("T", ...) returns Id<"T">. */
  | { kind: "idValueOf"; table: string }
  /** Primitive string/number/boolean from a recognised producer. `value` is
   *  set for literal sources (`const s = "active"`) so the matcher can check it
   *  against a `v.literal(...)` branch; unbounded producers leave it unset. */
  | { kind: "primitive"; primitive: "string" | "number" | "boolean"; value?: string | number | boolean }
  /** Result of a `ctx.runQuery/runMutation/runAction(internal.x.y, ...)` —
   *  carries the called function's `returns` shape. Materialises as a
   *  `passthrough` intent when used at a return site. */
  | { kind: "shapeOf"; shape: Shape; from: string }
  | { kind: "param" }
  | { kind: "unknown"; expr: string };

function buildScope(handler: HandlerFn, ctx: AnalyzeContext): Scope {
  const scope: Scope = {
    vars: new Map(),
    argsShape: ctx.argsShape,
    schema: ctx.schema,
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

  // Narrow nullable bindings guarded by an early-exit null check (C1) —
  // `const x = await ctx.db.get(id); if (!x) throw …; return x;` is the single
  // most common Convex idiom; without this it fires a spurious NULL_BRANCH.
  applyNullGuards(body, scope);
  // Re-propagate narrowing into top-level alias / destructure bindings that
  // derive from a now-narrowed variable (`const { secret, ...rest } = u`).
  repropagateDerivedBindings(body, scope);

  return scope;
}

/**
 * Walk the handler block's *top-level* statements for early-exit null guards
 * and flip the guarded binding(s) to non-null. Conservative on purpose:
 *  - only top-level `if` statements (never nested in callbacks);
 *  - only when the then-branch provably exits (throw / return);
 *  - recognizes `!x`, `x === null`/`x == null`, loose `x == undefined`, and
 *    disjunctions `if (!x || cond) throw` (fall-through is `!x && !cond`);
 *  - positive guards (`if (x !== null)`) and `&&` conditions are ignored.
 */
function applyNullGuards(block: Block, scope: Scope): void {
  for (const stmt of block.getStatements()) {
    if (!Node.isIfStatement(stmt)) continue;
    if (!thenBranchExits(stmt.getThenStatement())) continue;
    for (const name of guardedNullNames(stmt.getExpression())) {
      narrowNonNull(name, scope);
    }
  }
}

/** Flip a guarded binding to non-null — rowOf clears `nullable`, shapeOf
 *  (e.g. ctx.storage.getUrl → string|null) strips the null union member. */
function narrowNonNull(name: string, scope: Scope): void {
  const info = scope.vars.get(name);
  if (!info) return;
  if (info.origin.kind === "rowOf" && info.origin.nullable) {
    scope.vars.set(name, { ...info, origin: { ...info.origin, nullable: false } });
  } else if (info.origin.kind === "shapeOf" && shapeContainsNull(info.origin.shape)) {
    scope.vars.set(name, {
      ...info,
      origin: { ...info.origin, shape: stripNull(info.origin.shape) },
    });
  }
}

function repropagateDerivedBindings(block: Block, scope: Scope): void {
  for (const stmt of block.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      // Only re-bind aliases / destructures of an existing variable — never a
      // fresh producer (`const u = ctx.db.get(...)`), which would undo narrowing.
      if (init && unwrapsToIdentifier(init)) bindDeclaration(decl, scope);
    }
  }
}

function unwrapsToIdentifier(expr: Node): boolean {
  let e: Node = expr;
  while (
    Node.isAwaitExpression(e) ||
    Node.isParenthesizedExpression(e) ||
    Node.isAsExpression(e) ||
    Node.isTypeAssertion(e) ||
    Node.isNonNullExpression(e)
  ) {
    e = e.getExpression();
  }
  return Node.isIdentifier(e);
}

function thenBranchExits(stmt: Node | undefined): boolean {
  if (!stmt) return false;
  if (Node.isThrowStatement(stmt) || Node.isReturnStatement(stmt)) return true;
  if (Node.isBlock(stmt)) {
    return stmt
      .getStatements()
      .some((s) => Node.isThrowStatement(s) || Node.isReturnStatement(s));
  }
  return false;
}

/** Names provably non-null on the fall-through of an early-exit guard. */
function guardedNullNames(cond: Node): string[] {
  if (Node.isParenthesizedExpression(cond)) return guardedNullNames(cond.getExpression());
  // `!x`
  if (
    Node.isPrefixUnaryExpression(cond) &&
    cond.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    const operand = cond.getOperand();
    return Node.isIdentifier(operand) ? [operand.getText()] : [];
  }
  if (Node.isBinaryExpression(cond)) {
    const op = cond.getOperatorToken().getText();
    // `if (A || B) exit` → fall-through is `!A && !B` → narrow both sides.
    // (`&&` is intentionally NOT handled — `if (A && B) exit` proves neither.)
    if (op === "||") {
      return [...guardedNullNames(cond.getLeft()), ...guardedNullNames(cond.getRight())];
    }
    if (op === "===" || op === "==") {
      const left = cond.getLeft();
      const right = cond.getRight();
      const id = Node.isIdentifier(left) ? left : Node.isIdentifier(right) ? right : null;
      const lit = Node.isIdentifier(left) ? right : left;
      if (id && isNarrowingNullCompare(op, lit)) return [id.getText()];
    }
  }
  return [];
}

/**
 * True when `<id> <op> <lit>` proves the id non-null on fall-through. `null`
 * comparisons always count. A strict `=== undefined` does NOT — `.first()`,
 * `.unique()` and `ctx.db.get()` return `T | null` (never `undefined`), so the
 * guard can never fire for a missing doc; treating it as narrowing would hide
 * a real null return (soundness). Loose `== undefined` matches null too.
 */
function isNarrowingNullCompare(op: string, lit: Node): boolean {
  if (lit.getKind() === SyntaxKind.NullKeyword) return true;
  if (Node.isIdentifier(lit) && lit.getText() === "undefined") return op === "==";
  return false;
}

function isNullishLiteral(n: Node): boolean {
  return (
    n.getKind() === SyntaxKind.NullKeyword ||
    (Node.isIdentifier(n) && n.getText() === "undefined")
  );
}

/** True when an expression is unambiguously a string (so `x + <this>` is concat).
 *  Recurses through `+` so a nested literal (`u.first + " " + u.last`, which
 *  parses as `(u.first + " ") + u.last`) is recognized. */
function isStringish(n: Node): boolean {
  if (
    Node.isStringLiteral(n) ||
    Node.isTemplateExpression(n) ||
    Node.isNoSubstitutionTemplateLiteral(n)
  ) {
    return true;
  }
  if (Node.isParenthesizedExpression(n)) return isStringish(n.getExpression());
  if (Node.isBinaryExpression(n) && n.getOperatorToken().getText() === "+") {
    return isStringish(n.getLeft()) || isStringish(n.getRight());
  }
  return false;
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
  // unwrap await / parens / type assertions / non-null
  if (Node.isAwaitExpression(expr)) {
    return inferOrigin(expr.getExpression(), scope);
  }
  if (Node.isParenthesizedExpression(expr)) {
    return inferOrigin(expr.getExpression(), scope);
  }
  if (Node.isAsExpression(expr) || Node.isTypeAssertion(expr)) {
    return inferOrigin(expr.getExpression(), scope);
  }
  if (Node.isNonNullExpression(expr)) {
    const inner = inferOrigin(expr.getExpression(), scope);
    if (inner.kind === "rowOf") return { ...inner, nullable: false };
    return inner;
  }

  // primitive literals — `const x = 0`, `const s = "hello"`, etc. Carry the
  // value so a value-bounded const checks against `v.literal(...)` (B17).
  if (Node.isStringLiteral(expr)) {
    return { kind: "primitive", primitive: "string", value: expr.getLiteralValue() };
  }
  if (Node.isNumericLiteral(expr)) {
    return { kind: "primitive", primitive: "number", value: Number(expr.getLiteralValue()) };
  }
  if (expr.getKind() === SyntaxKind.TrueKeyword) {
    return { kind: "primitive", primitive: "boolean", value: true };
  }
  if (expr.getKind() === SyntaxKind.FalseKeyword) {
    return { kind: "primitive", primitive: "boolean", value: false };
  }

  // array literal — `const arr = []` or `const arr = [...]`
  if (Node.isArrayLiteralExpression(expr)) {
    const first = expr.getElements()[0];
    if (!first) {
      return {
        kind: "literalArrayOf",
        element: { kind: "unanalyzed", reason: "empty array element" },
      };
    }
    return {
      kind: "literalArrayOf",
      element: classifyExpression(first as Expression, scope),
    };
  }

  // Template literal → string (`\`${a} ${b}\``). Unambiguous.
  if (Node.isTemplateExpression(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return { kind: "primitive", primitive: "string" };
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
    // <paginatedOf>.page → rowsOf<T>
    // (Convex paginate() result has `.page: T[]`. Lets `result.page.filter(...)`
    // and `result.page.map(...)` flow through cardinality tracking.)
    if (Node.isIdentifier(recv) && expr.getName() === "page") {
      const info = scope.vars.get(recv.getText());
      if (info && info.origin.kind === "paginatedOf") {
        return { kind: "rowsOf", table: info.origin.table };
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

  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    // `a ?? b` / `a || b` — nullability comes from the RHS (C2). Mirrors the
    // classifyExpression path for const-bound `const x = get(id) ?? fallback!`.
    if (op === "??" || op === "||") {
      const left = inferOrigin(expr.getLeft(), scope);
      const rightNullable = exprIsNullable(expr.getRight() as Expression, scope);
      if (left.kind === "rowOf") return { ...left, nullable: rightNullable };
      if (left.kind === "shapeOf" && !rightNullable) {
        return { ...left, shape: stripNull(left.shape) };
      }
      return left;
    }
    // Arithmetic / string-concat — only when the operator makes the result type
    // unambiguous (avoids guessing on opaque `a + b` with unknown operands).
    if (op === "-" || op === "*" || op === "/" || op === "%") {
      return { kind: "primitive", primitive: "number" };
    }
    if (op === "+" && (isStringish(expr.getLeft()) || isStringish(expr.getRight()))) {
      return { kind: "primitive", primitive: "string" };
    }
  }

  return { kind: "unknown", expr: expr.getText().slice(0, 80) };
}

/** True when an expression can evaluate to null/undefined (best-effort). Used
 *  to derive the nullability of a `??`/`||` result from its RHS. */
function exprIsNullable(expr: Expression, scope: Scope): boolean {
  if (Node.isNonNullExpression(expr)) return false; // `x!` is non-null
  if (isNullishLiteral(expr)) return true;
  const c = classifyExpression(expr, scope);
  if (c.kind === "null") return true;
  if (c.kind === "row" && c.nullable) return true;
  if (c.kind === "passthrough") return shapeContainsNull(c.shape);
  return false;
}

function shapeContainsNull(shape: Shape): boolean {
  if (shape.kind === "null") return true;
  if (shape.kind === "union") return shape.members.some(shapeContainsNull);
  if (shape.kind === "optional") return true;
  return false;
}

/** Remove the `null` member from a union shape (used by `?? non-null`). */
function stripNull(shape: Shape): Shape {
  if (shape.kind !== "union") return shape;
  const members = shape.members.filter((m) => m.kind !== "null");
  if (members.length === 0) return shape;
  if (members.length === 1) return members[0]!;
  return { kind: "union", members };
}

function originFromCall(call: CallExpression, scope: Scope): VarOrigin {
  const expr = call.getExpression();

  // Map / paginate end-call: catch top-level then descend
  if (Node.isPropertyAccessExpression(expr)) {
    const method = expr.getName();
    const receiver = expr.getExpression();

    // ctx.runQuery / runMutation / runAction(internal.x.y, ...)
    if (
      (method === "runQuery" || method === "runMutation" || method === "runAction") &&
      receiverText(receiver) === "ctx" &&
      scope.resolveRunCall
    ) {
      const target = call.getArguments()[0];
      const segments = target ? readApiSegments(target) : null;
      if (segments && segments.length > 0) {
        const shape = scope.resolveRunCall(segments);
        if (shape) return { kind: "shapeOf", shape, from: segments.join(".") };
      }
    }

    // Promise.all(<expr>) — recurse into <expr>'s origin.
    if (
      Node.isIdentifier(receiver) &&
      receiver.getText() === "Promise" &&
      method === "all"
    ) {
      const arg = call.getArguments()[0];
      if (arg) return inferOrigin(arg as Expression, scope);
      return { kind: "unknown", expr: call.getText().slice(0, 80) };
    }

    // ctx.db.get(id) — rowOf table inferred from id arg
    if (method === "get" && receiverText(receiver) === "ctx.db") {
      const idArg = call.getArguments()[0];
      const table = idArg ? inferTableFromIdArg(idArg, scope) : null;
      return { kind: "rowOf", table: table ?? "<unknown>", nullable: true };
    }

    // ctx.db.insert("T", ...) → idValue<T>
    if (method === "insert" && receiverText(receiver) === "ctx.db") {
      const tableArg = call.getArguments()[0];
      if (tableArg && Node.isStringLiteral(tableArg)) {
        return { kind: "idValueOf", table: tableArg.getLiteralValue() };
      }
    }

    // ctx.storage.generateUploadUrl() → string
    if (
      method === "generateUploadUrl" &&
      receiverText(receiver) === "ctx.storage"
    ) {
      return { kind: "primitive", primitive: "string" };
    }
    // ctx.storage.getUrl(id) → string | null. The url is null when the storage
    // id is missing, so the validator must allow null (B3). `?? fallback` /
    // direct non-null narrowing strips the null member upstream.
    if (method === "getUrl" && receiverText(receiver) === "ctx.storage") {
      return {
        kind: "shapeOf",
        shape: { kind: "union", members: [{ kind: "string" }, { kind: "null" }] },
        from: "ctx.storage.getUrl",
      };
    }

    // JSON.stringify(...) → string
    if (
      method === "stringify" &&
      Node.isIdentifier(receiver) &&
      receiver.getText() === "JSON"
    ) {
      return { kind: "primitive", primitive: "string" };
    }

    // .filter(...) / .slice(...) / .sort(...) — preserve receiver cardinality.
    // A null-removing `.filter(u => u !== null)` / `.filter(Boolean)` makes the
    // array element non-null (the canonical fan-out-join cleanup).
    if (method === "filter") {
      const recvOrigin = inferOrigin(receiver, scope);
      const pred = call.getArguments()[0];
      if (
        pred &&
        isNullRemovingPredicate(pred) &&
        recvOrigin.kind === "literalArrayOf"
      ) {
        return { kind: "literalArrayOf", element: stripIntentNull(recvOrigin.element) };
      }
      return recvOrigin;
    }
    if (method === "slice" || method === "sort") {
      return inferOrigin(receiver, scope);
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
        return { kind: "literalArrayOf", element: mapped.element, elements: mapped.elements };
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

/**
 * True for predicates that remove null/undefined elements: `Boolean`, `u => u`,
 * `u => !!u`, `u => Boolean(u)`, `u => u !== null`, and — crucially for real
 * code — compound type-guard predicates like
 *   `(u): u is Doc<"t"> => u !== null && u !== undefined && !u.tool && …`
 * which Convex codebases use to filter a `Promise.all(ids.map(get))` fan-out.
 */
function isNullRemovingPredicate(pred: Node): boolean {
  if (Node.isIdentifier(pred)) return pred.getText() === "Boolean";
  if (!Node.isArrowFunction(pred) && !Node.isFunctionExpression(pred)) return false;
  const param = pred.getParameters()[0];
  if (!param) return false;
  const pName = param.getName();

  // `(u): u is T => …` — a type-predicate narrowing to a non-nullable T is a
  // null filter regardless of the body's exact form.
  const ret = pred.getReturnTypeNode();
  if (ret && Node.isTypePredicate(ret)) {
    const t = ret.getTypeNode()?.getText() ?? "";
    if (t && !/\b(null|undefined)\b/.test(t)) return true;
  }

  let body: Node | undefined = pred.getBody();
  if (Node.isBlock(body)) {
    const rets = body.getStatements().filter(Node.isReturnStatement);
    if (rets.length !== 1) return false;
    body = rets[0]!.getExpression();
  }
  if (!body) return false;
  return exprExcludesNull(body, pName);
}

/** True when `node` (the predicate body) provably excludes null/undefined for
 *  the param `pName`. Recurses through `&&` — any conjunct that excludes null
 *  makes the whole result non-null. */
function exprExcludesNull(node: Node, pName: string): boolean {
  if (Node.isParenthesizedExpression(node)) return exprExcludesNull(node.getExpression(), pName);
  // `u`
  if (Node.isIdentifier(node)) return node.getText() === pName;
  // `!!u`
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken) {
    const inner = node.getOperand();
    return (
      Node.isPrefixUnaryExpression(inner) &&
      inner.getOperatorToken() === SyntaxKind.ExclamationToken &&
      Node.isIdentifier(inner.getOperand()) &&
      inner.getOperand().getText() === pName
    );
  }
  // `Boolean(u)`
  if (Node.isCallExpression(node)) {
    const e = node.getExpression();
    return Node.isIdentifier(e) && e.getText() === "Boolean";
  }
  if (Node.isBinaryExpression(node)) {
    const op = node.getOperatorToken().getText();
    // `&&` chain — any conjunct excluding null suffices.
    if (op === "&&") {
      return exprExcludesNull(node.getLeft(), pName) || exprExcludesNull(node.getRight(), pName);
    }
    // `u !== null` / `u != null` / `u !== undefined`
    if (op === "!==" || op === "!=") {
      const l = node.getLeft();
      const r = node.getRight();
      const idIsParam = (n: Node) => Node.isIdentifier(n) && n.getText() === pName;
      if ((idIsParam(l) && isNullishLiteral(r)) || (idIsParam(r) && isNullishLiteral(l))) {
        return true;
      }
    }
  }
  return false;
}

function stripIntentNull(intent: ReturnIntent): ReturnIntent {
  if (intent.kind === "row" && intent.nullable) return { ...intent, nullable: false };
  return intent;
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
  if (Node.isPropertyAccessExpression(arg)) {
    const recv = arg.getExpression();
    const fieldName = arg.getName();
    // case: `args.foo` where args validator declares foo as v.id("T")
    if (
      Node.isIdentifier(recv) &&
      scope.argsParamName === recv.getText() &&
      scope.argsShape
    ) {
      const fs = scope.argsShape.get(fieldName);
      if (fs && fs.shape.kind === "id") return fs.shape.table;
    }
    // case: `row.fkId` — foreign-key join. `row` is a rowOf<T>, `fkId` is a
    // v.id("U") field on T, so `ctx.db.get(row.fkId)` reads table U (B1).
    if (Node.isIdentifier(recv)) {
      const info = scope.vars.get(recv.getText());
      if (info?.origin.kind === "rowOf") {
        if (fieldName === "_id") return info.origin.table;
        const tbl = scope.schema?.tables.get(info.origin.table);
        const fs = tbl?.fields.get(fieldName);
        if (fs && fs.shape.kind === "id") return fs.shape.table;
      }
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
    case "idValueOf":
      return `idValue<${o.table}>`;
    case "primitive":
      return o.primitive;
    case "shapeOf":
      return `shape<${o.from}>`;
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

  // unwrap parens, `as const`, `as T`, type assertions, non-null assertion
  if (Node.isParenthesizedExpression(expr)) {
    return classifyExpression(expr.getExpression(), scope);
  }
  if (Node.isAsExpression(expr) || Node.isTypeAssertion(expr)) {
    return classifyExpression(expr.getExpression(), scope);
  }
  if (Node.isNonNullExpression(expr)) {
    const inner = classifyExpression(expr.getExpression(), scope);
    // non-null assertion strips nullability — drop the `nullable` flag on rows.
    if (inner.kind === "row" && inner.nullable) {
      return { ...inner, nullable: false };
    }
    return inner;
  }

  // null / undefined
  if (expr.getKind() === SyntaxKind.NullKeyword) return { kind: "null" };
  if (Node.isIdentifier(expr) && expr.getText() === "undefined") return { kind: "null" };

  // primitive literals — carry the literal value (B17).
  if (Node.isStringLiteral(expr)) {
    return { kind: "primitive", primitive: "string", value: expr.getLiteralValue() };
  }
  if (Node.isNumericLiteral(expr)) {
    return { kind: "primitive", primitive: "number", value: Number(expr.getLiteralValue()) };
  }
  if (expr.getKind() === SyntaxKind.TrueKeyword) {
    return { kind: "primitive", primitive: "boolean", value: true };
  }
  if (expr.getKind() === SyntaxKind.FalseKeyword) {
    return { kind: "primitive", primitive: "boolean", value: false };
  }

  // Array literal `[...]` — treat as literalArray of first element. Empty
  // array (`return []`) is compatible with any v.array(...) — surface as
  // literalArray<unanalyzed> so the matcher's array-cardinality check still
  // runs but no element-level error fires.
  if (Node.isArrayLiteralExpression(expr)) {
    const first = expr.getElements()[0];
    if (!first) {
      return {
        kind: "literalArray",
        element: { kind: "unanalyzed", reason: "empty array element" },
      };
    }
    return { kind: "literalArray", element: classifyExpression(first as Expression, scope) };
  }

  // `a ?? b` / `a || b` — the result is null only when the RHS can be null, so
  // the nullability comes from the RHS, not the LHS (C2). `doc ?? fallback!`
  // is non-null; `doc ?? null` and `docA ?? docB` (both nullable) stay nullable.
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === "??" || op === "||") {
      const left = classifyExpression(expr.getLeft() as Expression, scope);
      const rightNullable = exprIsNullable(expr.getRight() as Expression, scope);
      if (left.kind === "row") return { ...left, nullable: rightNullable };
      if (left.kind === "passthrough" && !rightNullable) {
        return { ...left, shape: stripNull(left.shape) };
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

  // PropertyAccessExpression — `foo.bar` where foo is a known binding.
  if (Node.isPropertyAccessExpression(expr)) {
    return classifyPropertyAccess(expr, scope);
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
    schema: scope.schema,
    resolveRunCall: scope.resolveRunCall,
  };
  const receiverOrigin = inferOrigin(expr.getExpression(), scope);
  const params = arg.getParameters();
  if (params[0]) {
    const elementOrigin = elementOriginOf(receiverOrigin);
    const nameNode = params[0].getNameNode();
    if (Node.isIdentifier(nameNode)) {
      if (elementOrigin) subScope.vars.set(nameNode.getText(), { origin: elementOrigin });
    } else if (Node.isObjectBindingPattern(nameNode)) {
      bindDestructuredParam(nameNode, elementOrigin, subScope);
    }
  }

  const body = arg.getBody();
  let collected: ReturnIntent[];
  if (Node.isBlock(body)) {
    const rets = collectReturnStatements(body);
    if (rets.length === 0) return null;
    collected = [];
    for (const ret of rets) {
      const expr = ret.getExpression();
      if (!expr) continue;
      for (const branch of expandConditionals(expr)) {
        collected.push(classifyExpression(branch, subScope));
      }
    }
  } else {
    // Expression body — expand `x => cond ? a : b` into both element shapes.
    collected = expandConditionals(body as Expression).map((b) =>
      classifyExpression(b, subScope),
    );
  }
  if (collected.length === 0) return null;

  // `if (skip) return null; return {...}` + downstream `.filter(Boolean)` is
  // common: prefer the non-null payload(s), but if every branch is null keep
  // them so an all-null map is still surfaced. When more than one distinct
  // non-null shape survives (e.g. `cond ? a : b`), diff every one (B11).
  const meaningful = collected.filter((i) => i.kind !== "null");
  const elements = dedupeIntents(meaningful.length > 0 ? meaningful : collected);
  return {
    kind: "literalArray",
    element: elements[0]!,
    elements: elements.length > 1 ? elements : undefined,
  };
}

/**
 * Bind the names destructured out of a `.map` callback parameter
 * (`({ a, b: c, ...rest }) => ...`) into the sub-scope. Each binding SHADOWS any
 * same-named outer variable — without this a field like `online` leaks to an
 * outer `const online = ...collect()` array and the analyzer invents a spurious
 * TYPE_MISMATCH (the get-convex/presence `list`/`listRoom`/`listUser` false
 * positive: a row field shadowed by a same-named outer rows<T> array).
 *
 * When the mapped element is a known schema row, each field resolves to its
 * column shape — so a genuinely-reprojected field that drifts is still caught;
 * otherwise the name is bound opaque (`param`) so it can never invent drift.
 */
function bindDestructuredParam(
  pattern: ObjectBindingPattern,
  elementOrigin: VarOrigin | null,
  subScope: Scope,
): void {
  let rowFields: Map<string, FieldShape> | null = null;
  if (elementOrigin?.kind === "rowOf") {
    const t = subScope.schema?.tables.get(elementOrigin.table);
    const rs = t ? rowShape(t) : null;
    if (rs && rs.kind === "object") rowFields = rs.fields;
  }
  for (const el of pattern.getElements()) {
    const localNameNode = el.getNameNode();
    // Nested destructure (`{ a: { b } }`) — shadow its names opaquely so they
    // can't leak to an outer binding either.
    if (Node.isObjectBindingPattern(localNameNode)) {
      bindDestructuredParam(localNameNode, null, subScope);
      continue;
    }
    if (!Node.isIdentifier(localNameNode)) continue;
    const localName = localNameNode.getText();
    if (el.getDotDotDotToken()) {
      // `...rest` collects the remaining fields as an object — opaque.
      subScope.vars.set(localName, { origin: { kind: "param" } });
      continue;
    }
    // Source field is the renamed property (`{ src: local }`) or the local name.
    const propNode = el.getPropertyNameNode();
    const propName =
      propNode && Node.isIdentifier(propNode) ? propNode.getText() : localName;
    const fs = rowFields?.get(propName);
    subScope.vars.set(localName, {
      origin: fs
        ? { kind: "shapeOf", shape: fs.shape, from: `destructure:${propName}` }
        : { kind: "param" },
    });
  }
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

/**
 * Classify `<recv>.<field>` against scope. The common cases:
 *   - `row._id` / `row._creationTime` (system fields)
 *   - `row.<schemaField>` — resolves to the field's shape via schema lookup
 *   - `args.<idField>` — already handled in inferOrigin's idOf path; here we
 *     surface it as `idValue<T>` for direct returns.
 */
function classifyPropertyAccess(
  expr: import("ts-morph").PropertyAccessExpression,
  scope: Scope,
): ReturnIntent {
  const recv = expr.getExpression();
  const fieldName = expr.getName();

  // args.<idField> → idValue (caller might `return args.id`).
  if (
    Node.isIdentifier(recv) &&
    scope.argsParamName === recv.getText() &&
    scope.argsShape
  ) {
    const fs = scope.argsShape.get(fieldName);
    if (fs && fs.shape.kind === "id") {
      return { kind: "idValue", table: fs.shape.table };
    }
    if (fs) {
      return { kind: "passthrough", shape: fs.shape, from: `args.${fieldName}` };
    }
  }

  // <paginatedOf<T>>.page → rows<T> (direct `return result.page`, B9).
  if (Node.isIdentifier(recv)) {
    const info = scope.vars.get(recv.getText());
    if (info?.origin.kind === "paginatedOf" && fieldName === "page") {
      return { kind: "rows", table: info.origin.table, drop: new Set(), add: new Map() };
    }
    // <rows<T>>.length / <literalArray>.length → number (count query, B13).
    if (
      fieldName === "length" &&
      (info?.origin.kind === "rowsOf" || info?.origin.kind === "literalArrayOf")
    ) {
      return { kind: "primitive", primitive: "number" };
    }
  }

  // <rowOf<T>>.<field>
  if (Node.isIdentifier(recv)) {
    const info = scope.vars.get(recv.getText());
    if (info?.origin.kind === "rowOf") {
      const table = info.origin.table;
      if (fieldName === "_id") return { kind: "idValue", table };
      if (fieldName === "_creationTime") {
        return { kind: "primitive", primitive: "number" };
      }
      const tbl = scope.schema?.tables.get(table);
      const fs = tbl?.fields.get(fieldName);
      if (fs) {
        return { kind: "passthrough", shape: fs.shape, from: `${table}.${fieldName}` };
      }
    }
    if (info?.origin.kind === "literal") {
      const s = info.origin.fields.get(fieldName);
      if (s) return { kind: "passthrough", shape: s, from: `<literal>.${fieldName}` };
    }
  }

  return { kind: "unanalyzed", reason: `unsupported return expr: PropertyAccessExpression` };
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
      return { kind: "literalArray", element: origin.element, elements: origin.elements };
    case "idOf":
      return { kind: "unanalyzed", reason: `returning bare id<${origin.table}>` };
    case "idValueOf":
      return { kind: "idValue", table: origin.table };
    case "primitive":
      return { kind: "primitive", primitive: origin.primitive, value: origin.value };
    case "shapeOf":
      return { kind: "passthrough", shape: origin.shape, from: origin.from };
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
  // Captured when handler explicitly assigns `page: <expr>` AND the spread
  // base is paginated. The matcher uses this to validate against the
  // validator's `page.element` rather than diffing the schema row.
  let pageOverride: ReturnIntent | null = null;

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
      if (name === "page" && init) {
        pageOverride = classifyExpression(init as Expression, scope);
      }
      literalFieldsMap.set(name, init ? addShapeOf(init, scope) : { kind: "any" });
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      const name = prop.getName();
      if (name === "page") {
        pageOverride = classifyVar(name, scope);
      }
      const info = scope.vars.get(name);
      const shape: Shape =
        info && !info.drop ? shapeFromOrigin(info.origin, scope) ?? { kind: "any" } : { kind: "any" };
      literalFieldsMap.set(name, shape);
    }
  }

  if (baseOrigin) {
    if (
      baseOrigin.kind === "paginatedOf" &&
      pageOverride &&
      pageOverride.kind !== "unanalyzed"
    ) {
      return {
        kind: "paginated",
        table: baseOrigin.table,
        drop: baseDrop,
        add: literalFieldsMap,
        pageOverride,
      };
    }
    // Note: a *guarded* nullable row is already narrowed to non-null by the
    // null-guard pass, so `if (!doc) throw; return { ...doc }` is clean. An
    // *unguarded* `{ ...maybeNullDoc }` keeps `nullable`, so the matcher flags
    // it — on the null path the spread collapses to `{}` and Convex throws.
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

/**
 * Capture the shape of an object-literal initializer for use in `intent.add`.
 * Falls back to `literalShapeOf` for literals; otherwise detects optional
 * chains (`a?.b`, `a?.b()`) and wraps as `optional<any>` so the matcher
 * doesn't flag OPTIONALITY_MISMATCH against a correctly-optional validator
 * field. Anything else returns `any`.
 */
function initShapeOf(node: Node, _scope: Scope): Shape {
  const lit = literalShapeOf(node);
  if (lit.kind === "literal") return lit;
  if (hasOptionalChain(node)) return { kind: "optional", inner: { kind: "any" } };
  return { kind: "any" };
}

/**
 * Shape of an added/enrichment field's initializer. When the value is a *whole
 * document* read (`row` / `.collect()` / a runQuery result), we synthesize the
 * concrete schema-derived Shape so the matcher can diff the nested validator
 * against it (B2 join/enrichment drift). Projections (`.map(...)`) and opaque
 * expressions fall back to `initShapeOf` → `any`, so they never invent drift.
 */
function addShapeOf(node: Node, scope: Scope): Shape {
  const origin = inferOrigin(node as Expression, scope);
  const fromOrigin = shapeFromOrigin(origin, scope);
  return fromOrigin ?? initShapeOf(node, scope);
}

function shapeFromOrigin(origin: VarOrigin, scope: Scope): Shape | null {
  switch (origin.kind) {
    case "rowOf": {
      const t = scope.schema?.tables.get(origin.table);
      if (!t) return null;
      const obj = rowShape(t);
      return origin.nullable ? { kind: "union", members: [obj, { kind: "null" }] } : obj;
    }
    case "rowsOf": {
      const t = scope.schema?.tables.get(origin.table);
      return t ? { kind: "array", element: rowShape(t) } : null;
    }
    case "idValueOf":
      return { kind: "id", table: origin.table };
    case "shapeOf":
      return origin.shape;
    case "primitive":
      return origin.value !== undefined
        ? { kind: "literal", value: origin.value }
        : { kind: origin.primitive };
    default:
      return null;
  }
}

function hasOptionalChain(node: Node): boolean {
  let current: Node | undefined = node;
  // unwrap top-level `as` / type assertion
  while (current && (Node.isAsExpression(current) || Node.isTypeAssertion(current))) {
    current = current.getExpression();
  }
  while (current) {
    if (
      Node.isPropertyAccessExpression(current) ||
      Node.isCallExpression(current) ||
      Node.isElementAccessExpression(current)
    ) {
      const q = (current.compilerNode as { questionDotToken?: unknown }).questionDotToken;
      if (q) return true;
      current = current.getExpression() as Node;
      continue;
    }
    break;
  }
  return false;
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
