import { Node, ts, type CallExpression, type Type, type Project } from "ts-morph";
import { relative as pathRelative } from "node:path";
import type { FieldShape, Issue, Shape } from "./types.ts";
import { makeIssue } from "./rules.ts";

type Status = "optional" | "undefined" | "unknown" | "any";

interface Finding {
  status: Status;
  path: string;
  field: FieldShape | null;
  typeText: string;
  site: Node;
}

interface Target {
  shape: Shape;
  required: boolean;
  path: string;
  field: FieldShape | null;
}

interface State {
  depth: number;
  active: Set<Node>;
}

const MAX_DEPTH = 12;

/** A shape registered here must not add its key to the reported path. */
const SYNTH = new WeakMap<object, { path: string; field: FieldShape | null; required: boolean }>();

export interface AnyUndefinedFn {
  filePath: string;
  exportName: string;
  /** `relPath:exportName`, e.g. `catalogs/adapters/system:autoRebasePlan`. */
  key: string;
  returnsValidator: Shape | null;
  argsShape: Map<string, FieldShape> | undefined;
  handler: Node | null;
}

export function checkRequiredAny(
  fns: AnyUndefinedFn[],
  project: Project,
  convexDir: string,
): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const push = (fn: AnyUndefinedFn, kind: "returns" | "args", f: Finding, caller?: Node) => {
    const loc = f.field?.loc;
    const dedupe = `${fn.key}|${kind}|${f.path}|${f.status}|${loc?.file}:${loc?.line}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    issues.push(toIssue(fn, kind, f, convexDir, caller));
  };

  for (const fn of fns) {
    if (!fn.handler || !fn.returnsValidator) continue;
    // A top-level `undefined` return becomes `null`, which v.any() accepts, so
    // the value itself is not required; its fields and elements are.
    const target: Target = { shape: fn.returnsValidator, required: false, path: "", field: null };
    if (!containsRequiredAny(target.shape, false)) continue;
    for (const ret of returnExpressions(fn.handler)) {
      for (const f of checkValue(ret, target, { depth: 0, active: new Set([fn.handler]) })) {
        push(fn, "returns", f);
      }
    }
  }

  const byKey = new Map<string, AnyUndefinedFn>();
  for (const fn of fns) {
    if (fn.argsShape && containsRequiredAny(objectOf(fn.argsShape), true)) byKey.set(fn.key, fn);
  }
  if (byKey.size === 0) return issues;

  for (const sf of project.getSourceFiles()) {
    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const call = runCallParts(node);
      if (!call) return;
      const fn = byKey.get(call.key);
      if (!fn) return;
      const target: Target = { shape: objectOf(fn.argsShape!), required: true, path: "", field: null };
      for (const f of checkValue(call.args, target, { depth: 0, active: new Set() })) {
        push(fn, "args", f, node);
      }
    });
  }
  return issues;
}

function objectOf(fields: Map<string, FieldShape>): Shape {
  return { kind: "object", fields };
}

const RUN_METHODS = new Set(["runQuery", "runMutation", "runAction"]);
const SCHEDULER_METHODS = new Set(["runAfter", "runAt"]);

function runCallParts(call: Node): { key: string; args: Node } | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const method = callee.getName();
  const argv = call.getArguments();
  let refIdx: number;
  if (RUN_METHODS.has(method)) refIdx = 0;
  else if (SCHEDULER_METHODS.has(method)) refIdx = 1;
  else return null;
  const ref = argv[refIdx];
  const args = argv[refIdx + 1];
  if (!ref || !args) return null;
  const segments = refSegments(ref);
  if (!segments || segments.length < 2) return null;
  const exportName = segments[segments.length - 1]!;
  return { key: `${segments.slice(0, -1).join("/")}:${exportName}`, args };
}

/** `internal.a.b.fn` / `api.a.b.fn` → ["a", "b", "fn"]. */
function refSegments(node: Node): string[] | null {
  const out: string[] = [];
  let cur: Node = node;
  while (Node.isPropertyAccessExpression(cur)) {
    out.unshift(cur.getName());
    cur = cur.getExpression();
  }
  if (!Node.isIdentifier(cur)) return null;
  const root = cur.getText();
  if (root !== "internal" && root !== "api") return null;
  return out;
}

function checkValue(expr: Node, target: Target, st: State): Finding[] {
  if (!containsRequiredAny(target.shape, target.required)) return [];
  const node = unwrapExpr(expr);
  // Literals and ternaries are traced part by part even when their type is
  // concrete, so a finding points at the expression that holds the value.
  if (
    st.depth < MAX_DEPTH &&
    (Node.isObjectLiteralExpression(node) ||
      Node.isArrayLiteralExpression(node) ||
      Node.isConditionalExpression(node))
  ) {
    const traced = trace(node, target, { depth: st.depth + 1, active: st.active });
    if (traced) return traced;
  }
  const walked = walkType(safeType(node), target, node);
  if (!walked.hole) return walked.findings;
  if (st.depth < MAX_DEPTH) {
    const traced = trace(node, target, { depth: st.depth + 1, active: st.active });
    if (traced) return traced;
  }
  return walked.findings;
}

function safeType(node: Node): Type | null {
  try {
    return node.getType();
  } catch {
    return null;
  }
}

function unwrapExpr(node: Node): Node {
  let cur = node;
  for (;;) {
    if (
      Node.isParenthesizedExpression(cur) ||
      Node.isAwaitExpression(cur) ||
      Node.isNonNullExpression(cur) ||
      Node.isSatisfiesExpression(cur)
    ) {
      cur = cur.getExpression();
      continue;
    }
    if (Node.isAsExpression(cur) && cur.getTypeNode()?.getText() === "const") {
      cur = cur.getExpression();
      continue;
    }
    return cur;
  }
}

/** Follow an expression whose type is opaque back to where its value is built.
 *  Returns null when there is nothing to follow. */
function trace(node: Node, target: Target, st: State): Finding[] | null {
  if (Node.isConditionalExpression(node)) {
    return [
      ...checkValue(node.getWhenTrue(), target, st),
      ...checkValue(node.getWhenFalse(), target, st),
    ];
  }

  if (Node.isObjectLiteralExpression(node)) return traceObjectLiteral(node, target, st);

  if (Node.isArrayLiteralExpression(node)) {
    const arr = pickBranch(target.shape, "array");
    if (!arr || arr.kind !== "array") return null;
    const out: Finding[] = [];
    for (const el of node.getElements()) {
      if (Node.isSpreadElement(el)) out.push(...checkValue(el.getExpression(), { ...target, shape: arr }, st));
      else out.push(...checkValue(el, elementTarget(arr, target), st));
    }
    return out;
  }

  if (Node.isIdentifier(node)) {
    const decl = node.getSymbol()?.getDeclarations()[0];
    return decl ? traceDeclaration(decl, target, st) : null;
  }

  if (Node.isPropertyAccessExpression(node)) {
    return checkValue(node.getExpression(), wrapProperty(node.getName(), target), st);
  }

  if (Node.isElementAccessExpression(node)) {
    const arg = node.getArgumentExpression();
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      return checkValue(node.getExpression(), wrapProperty(arg.getLiteralValue(), target), st);
    }
    return checkValue(node.getExpression(), wrapElement(target), st);
  }

  if (Node.isCallExpression(node)) return traceCall(node, target, st);

  return null;
}

function traceDeclaration(decl: Node, target: Target, st: State): Finding[] | null {
  if (st.active.has(decl)) return null;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (!init || !Node.isIdentifier(decl.getNameNode())) return null;
    return withActive(st, decl, (inner) => checkValue(init, target, inner));
  }
  if (Node.isBindingElement(decl)) {
    // const { a } = expr  /  const { a: b } = expr
    const pattern = decl.getParent();
    const varDecl = pattern?.getParent();
    if (!Node.isObjectBindingPattern(pattern) || !Node.isVariableDeclaration(varDecl)) return null;
    if (decl.getDotDotDotToken()) return null;
    const init = varDecl.getInitializer();
    const key = decl.getPropertyNameNode()?.getText() ?? decl.getName();
    if (!init) return null;
    return withActive(st, decl, (inner) => checkValue(init, wrapProperty(key, target), inner));
  }
  return null;
}

function withActive<T>(st: State, node: Node, fn: (st: State) => T): T {
  st.active.add(node);
  try {
    return fn(st);
  } finally {
    st.active.delete(node);
  }
}

const PASS_THROUGH_ARRAY_METHODS = new Set([
  "filter",
  "slice",
  "concat",
  "sort",
  "toSorted",
  "reverse",
  "toReversed",
]);

function traceCall(call: CallExpression, target: Target, st: State): Finding[] | null {
  const callee = call.getExpression();
  if (Node.isPropertyAccessExpression(callee)) {
    const method = callee.getName();
    const receiver = callee.getExpression();
    if (PASS_THROUGH_ARRAY_METHODS.has(method)) return checkValue(receiver, target, st);
    if (method === "map") {
      const arr = pickBranch(target.shape, "array");
      const cb = call.getArguments()[0];
      if (!arr || arr.kind !== "array" || !cb) return null;
      if (!Node.isArrowFunction(cb) && !Node.isFunctionExpression(cb)) return null;
      const el = elementTarget(arr, target);
      return returnExpressions(cb).flatMap((r) => checkValue(r, el, st));
    }
  }

  const fnNode = resolveCallee(callee);
  if (!fnNode || st.active.has(fnNode)) return null;
  const rets = returnExpressions(fnNode);
  if (rets.length === 0) return null;
  return withActive(st, fnNode, (inner) => rets.flatMap((r) => checkValue(r, target, inner)));
}

function resolveCallee(callee: Node): Node | null {
  let decls: Node[] = [];
  try {
    const sym = callee.getSymbol();
    const aliased = sym?.getAliasedSymbol() ?? sym;
    decls = aliased?.getDeclarations() ?? [];
  } catch {
    return null;
  }
  for (const d of decls) {
    if ((Node.isFunctionDeclaration(d) || Node.isMethodDeclaration(d)) && d.getBody()) return d;
    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
    }
  }
  return null;
}

/** Return expressions of a function, not counting nested functions'. */
export function returnExpressions(fn: Node): Node[] {
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();
    if (!Node.isBlock(body)) return [body];
  }
  const out: Node[] = [];
  const body = (fn as { getBody?: () => Node | undefined }).getBody?.();
  if (!body) return out;
  body.forEachDescendant((n, traversal) => {
    if (Node.isFunctionLikeDeclaration(n) || Node.isClassDeclaration(n)) {
      traversal.skip();
      return;
    }
    if (Node.isReturnStatement(n)) {
      const e = n.getExpression();
      if (e) out.push(e);
    }
  });
  return out;
}

function traceObjectLiteral(node: Node, target: Target, st: State): Finding[] | null {
  if (!Node.isObjectLiteralExpression(node)) return null;
  const t = safeType(node);
  const candidates = t ? selectObjectBranches(t, target.shape, node) : objectBranches(target.shape);
  if (candidates.length !== 1) return null;
  const branch = candidates[0]!;

  const props = new Map<string, Node>();
  const spreads: Node[] = [];
  for (const p of node.getProperties()) {
    if (Node.isPropertyAssignment(p)) {
      const init = p.getInitializer();
      if (init) props.set(propName(p.getNameNode()), init);
    } else if (Node.isShorthandPropertyAssignment(p)) {
      props.set(p.getName(), p);
    } else if (Node.isSpreadAssignment(p)) {
      spreads.push(p.getExpression());
    }
  }

  const out: Finding[] = [];
  for (const [k, fs] of branch.fields) {
    if (k.startsWith("__spread:")) continue;
    const child = fieldTarget(k, fs, target);
    const value = props.get(k);
    if (value && Node.isShorthandPropertyAssignment(value)) {
      const decl = value.getValueSymbol()?.getDeclarations()[0];
      const traced = decl ? traceDeclaration(decl, child, st) : null;
      out.push(...(traced ?? checkValue(value.getNameNode(), child, st)));
    } else if (value) {
      out.push(...checkValue(value, child, st));
    } else {
      for (const s of spreads) {
        out.push(...checkValue(s, wrapProperty(k, child), st));
      }
    }
  }
  return out;
}

function propName(n: Node): string {
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralValue();
  return n.getText();
}

interface Walk {
  findings: Finding[];
  /** True when some part of the type that could hold a required v.any() is
   *  opaque (`any`, a type parameter), so tracing the expression may say more. */
  hole: boolean;
}

function walkType(t: Type | null, target: Target, site: Node): Walk {
  const shape = resolve(target.shape);
  if (!t || !shape) return { findings: [], hole: t === null };
  if (shape.kind === "optional") {
    return walkType(t, { ...target, shape: shape.inner, required: false }, site);
  }
  if (!containsRequiredAny(shape, target.required)) return { findings: [], hole: false };

  if (shape.kind === "any") {
    const leaf = classifyLeaf(t);
    if (!leaf) return { findings: [], hole: false };
    if (leaf === "anyError") return { findings: [], hole: true };
    const finding = makeFinding(leaf === "anyExplicit" ? "any" : leaf, target, t, site);
    return { findings: [finding], hole: leaf === "anyExplicit" };
  }

  t = unwrapPromise(t);
  if (t.isAny() || t.isTypeParameter()) return { findings: [], hole: true };
  if (t.isUnknown()) return { findings: [], hole: false };

  if (t.isUnion()) {
    const out: Walk = { findings: [], hole: false };
    for (const m of t.getUnionTypes()) {
      if (m.isNull() || m.isUndefined()) continue;
      const w = walkType(m, target, site);
      out.findings.push(...w.findings);
      out.hole ||= w.hole;
    }
    return out;
  }

  const elem = arrayElementType(t);
  if (elem) {
    const arr = pickBranch(shape, "array");
    if (!arr || arr.kind !== "array") return { findings: [], hole: false };
    return walkType(elem, elementTarget(arr, target), site);
  }

  if (!t.isObject() && !t.isIntersection()) return { findings: [], hole: false };
  const branches = selectObjectBranches(t, shape, site);
  if (branches.length === 0) return { findings: [], hole: false };
  const walks = branches.map((b) => walkObject(t, b, target, site));
  if (walks.length === 1) return walks[0]!;
  // Ambiguous branch: keep only what every candidate agrees on.
  const keyOf = (f: Finding) => `${f.path}|${f.status}`;
  const common = walks
    .slice(1)
    .reduce((acc, w) => {
      const keys = new Set(w.findings.map(keyOf));
      return acc.filter((f) => keys.has(keyOf(f)));
    }, walks[0]!.findings);
  return { findings: common, hole: walks.some((w) => w.hole) };
}

function walkObject(
  t: Type,
  branch: Shape & { kind: "object" },
  target: Target,
  site: Node,
): Walk {
  const out: Walk = { findings: [], hole: false };
  for (const [k, fs] of branch.fields) {
    if (k.startsWith("__spread:")) continue;
    const prop = t.getProperty(k);
    if (!prop) continue;
    const child = fieldTarget(k, fs, target);
    const childShape = resolve(child.shape);
    if (childShape?.kind === "any" && child.required && prop.isOptional()) {
      out.findings.push(makeFinding("optional", child, propType(prop, site), site));
      continue;
    }
    const w = walkType(propType(prop, site), child, site);
    out.findings.push(...w.findings);
    out.hole ||= w.hole;
  }
  return out;
}

function propType(prop: import("ts-morph").Symbol, site: Node): Type | null {
  try {
    return prop.getTypeAtLocation(site);
  } catch {
    return null;
  }
}

/** "anyError" is an `any` from a type the analyzer can't load (an `Infer<>` or
 *  `Doc<>`): it proves nothing and stays silent. */
type Leaf = "undefined" | "unknown" | "anyExplicit" | "anyError" | null;

function classifyLeaf(t: Type): Leaf {
  if (t.isAny()) {
    return (t.compilerType as { intrinsicName?: string }).intrinsicName === "error"
      ? "anyError"
      : "anyExplicit";
  }
  if (t.isUnknown()) return "unknown";
  if (isUndefinedLike(t)) return "undefined";
  if (t.isTypeParameter()) return "anyError";
  if (t.isUnion()) {
    const members = t.getUnionTypes();
    if (members.some(isUndefinedLike)) return "undefined";
    const inner = members.map(classifyLeaf);
    if (inner.includes("unknown")) return "unknown";
    if (inner.includes("anyExplicit")) return "anyExplicit";
    if (inner.includes("anyError")) return "anyError";
  }
  return null;
}

function isUndefinedLike(t: Type): boolean {
  return t.isUndefined() || (t.getFlags() & ts.TypeFlags.Void) !== 0;
}

function unwrapPromise(t: Type): Type {
  const name = t.getSymbol()?.getName();
  if (name === "Promise" || name === "PromiseLike") {
    const arg = t.getTypeArguments()[0];
    if (arg) return unwrapPromise(arg);
  }
  return t;
}

function arrayElementType(t: Type): Type | null {
  if (t.isArray() || t.isReadonlyArray?.()) return t.getArrayElementType() ?? null;
  const name = t.getSymbol()?.getName();
  if (name === "ReadonlyArray" || name === "Array") return t.getTypeArguments()[0] ?? null;
  return null;
}

function resolve(shape: Shape): Shape | null {
  let s: Shape = shape;
  for (let i = 0; i < 10 && s.kind === "ref"; i++) {
    if (!s.resolved) return null;
    s = s.resolved;
  }
  return s.kind === "ref" ? null : s;
}

const requiredAnyCache = new WeakMap<Shape, boolean>();

/** True when the shape can hold a required `v.any()` somewhere a value can
 *  reach it (a required field, an array element, or the value itself). */
function containsRequiredAny(shape: Shape, required: boolean): boolean {
  const s = resolve(shape);
  if (!s) return false;
  if (s.kind === "any") return required;
  const cached = requiredAnyCache.get(s);
  if (cached !== undefined) return cached;
  requiredAnyCache.set(s, false); // cycle guard
  let result = false;
  switch (s.kind) {
    case "optional":
      result = containsRequiredAny(s.inner, false) || containsNestedRequiredAny(s.inner);
      break;
    case "union":
      result = s.members.some((m) => containsRequiredAny(m, required));
      break;
    case "array":
      result = containsRequiredAny(s.element, true);
      break;
    case "object":
      for (const [k, fs] of s.fields) {
        if (k.startsWith("__spread:")) continue;
        const syn = SYNTH.get(fs);
        if (containsRequiredAny(fs.shape, syn ? syn.required : !fs.optional)) result = true;
      }
      break;
    default:
      result = false;
  }
  requiredAnyCache.set(s, result);
  return result;
}

function containsNestedRequiredAny(shape: Shape): boolean {
  const s = resolve(shape);
  return !!s && s.kind !== "any" && containsRequiredAny(s, true);
}

function objectBranches(shape: Shape): (Shape & { kind: "object" })[] {
  const s = resolve(shape);
  if (!s) return [];
  if (s.kind === "object") return [s];
  if (s.kind === "optional") return objectBranches(s.inner);
  if (s.kind === "union") return s.members.flatMap(objectBranches);
  return [];
}

function pickBranch(shape: Shape, kind: "array"): Shape | null {
  const s = resolve(shape);
  if (!s) return null;
  if (s.kind === kind) return s;
  if (s.kind === "optional") return pickBranch(s.inner, kind);
  if (s.kind === "union") {
    for (const m of s.members) {
      const b = pickBranch(m, kind);
      if (b) return b;
    }
  }
  return null;
}

/** Object branches of `shape` that a value of type `t` can be, using literal
 *  fields (`type: v.literal("x")`) as discriminants. */
function selectObjectBranches(
  t: Type,
  shape: Shape,
  site: Node,
): (Shape & { kind: "object" })[] {
  const all = objectBranches(shape).filter((b) => containsRequiredAny(b, true));
  if (all.length <= 1) return all;
  let best: (Shape & { kind: "object" })[] = [];
  let bestScore = -1;
  for (const b of all) {
    let score = 0;
    let ok = true;
    for (const [k, fs] of b.fields) {
      const fshape = resolve(fs.shape);
      if (!fshape || fshape.kind !== "literal") continue;
      const prop = t.getProperty(k);
      if (!prop) {
        if (!fs.optional) ok = false;
        continue;
      }
      const pt = propType(prop, site);
      const values = pt ? literalValues(pt) : null;
      if (values === null) continue; // wider type: no information
      if (values.includes(fshape.value)) score += 1;
      else ok = false;
    }
    if (!ok) continue;
    if (score > bestScore) {
      best = [b];
      bestScore = score;
    } else if (score === bestScore) {
      best.push(b);
    }
  }
  return best;
}

function literalValues(t: Type): (string | number | boolean)[] | null {
  const members = t.isUnion() ? t.getUnionTypes() : [t];
  const out: (string | number | boolean)[] = [];
  for (const m of members) {
    if (m.isStringLiteral() || m.isNumberLiteral()) out.push(m.getLiteralValue() as string | number);
    else if (m.isBooleanLiteral()) out.push(m.getText() === "true");
    else return null;
  }
  return out;
}

function fieldTarget(
  key: string,
  fs: FieldShape,
  parent: Target,
): Target {
  const syn = SYNTH.get(fs);
  if (syn) return { shape: fs.shape, required: syn.required, path: syn.path, field: syn.field };
  return {
    shape: fs.shape,
    required: !fs.optional,
    path: parent.path ? `${parent.path}.${key}` : key,
    field: fs,
  };
}

function elementTarget(arr: Shape & { kind: "array" }, parent: Target): Target {
  const syn = SYNTH.get(arr);
  if (syn) return { shape: arr.element, required: syn.required, path: syn.path, field: syn.field };
  return { shape: arr.element, required: true, path: `${parent.path}[]`, field: parent.field };
}

function wrapProperty(key: string, target: Target): Target {
  const fs: FieldShape = { shape: target.shape, optional: !target.required };
  SYNTH.set(fs, { path: target.path, field: target.field, required: target.required });
  const shape: Shape = { kind: "object", fields: new Map([[key, fs]]) };
  return { shape, required: false, path: target.path, field: target.field };
}

function wrapElement(target: Target): Target {
  const shape: Shape = { kind: "array", element: target.shape };
  SYNTH.set(shape, { path: target.path, field: target.field, required: target.required });
  return { shape, required: false, path: target.path, field: target.field };
}

function makeFinding(status: Status, target: Target, t: Type | null, site: Node): Finding {
  let typeText = "unknown";
  try {
    typeText = t ? t.getText(site, ts.TypeFormatFlags.NoTruncation) : "unknown";
  } catch {
    /* keep the fallback */
  }
  return { status, path: target.path || "<value>", field: target.field, typeText, site };
}

const STATUS_TEXT: Record<Status, string> = {
  optional: "an optional property (`?:`), so it can be missing",
  undefined: "a type that includes `undefined`",
  unknown: "`unknown`, which includes `undefined`",
  any: "`any`, so it may be `undefined`",
};

function toIssue(
  fn: AnyUndefinedFn,
  kind: "returns" | "args",
  f: Finding,
  convexDir: string,
  caller?: Node,
): Issue {
  const loc = f.field?.loc;
  const key = loc?.text.split(":")[0]?.trim() ?? f.path.split(/[.[\]]/).filter(Boolean).pop() ?? f.path;
  const where = kind === "returns" ? "returns" : "args";
  const site = f.site;
  const siteRel = pathRelative(convexDir, site.getSourceFile().getFilePath());
  const callerText = caller
    ? ` Called from ${pathRelative(convexDir, caller.getSourceFile().getFilePath())}:${caller.getStartLineNumber()}.`
    : "";
  const severity = f.status === "any" ? "warn" : "error";
  const filePath = loc?.file ?? fn.filePath;
  const siteType = siteTypeText(site);
  return makeIssue("REQUIRED_ANY_UNDEFINED", {
    severity,
    filePath,
    line: loc?.line ?? 0,
    function: fn.exportName,
    message:
      f.status === "any"
        ? `Required v.any() field "${f.path}" in ${where} is fed a value typed \`any\` — if it is ever undefined, Convex rejects it`
        : `Required v.any() field "${f.path}" in ${where} can receive undefined — Convex drops the key and rejects the ${where === "returns" ? "return value" : "arguments"}`,
    detail: `The value is ${STATUS_TEXT[f.status]}: \`${truncate(site.getText(), 60)}\` at ${siteRel}:${site.getStartLineNumber()} is \`${truncate(siteType, 80)}\`${siteType === f.typeText ? "" : `, and "${key}" in it is \`${truncate(f.typeText, 80)}\``}.${callerText}`,
    fieldLoc: loc ? { line: loc.line, column: loc.column, text: loc.text } : undefined,
    fixCode: { before: loc?.text, after: `${key}: v.optional(v.any())` },
  });
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/import\("[^"]*"\)\./g, "").replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function siteTypeText(site: Node): string {
  try {
    return site.getType().getText(site);
  } catch {
    return "?";
  }
}

