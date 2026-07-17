import { Project, Node, type SourceFile } from "ts-morph";
import { resolve as pathResolve, relative as pathRelative } from "node:path";
import type { CallGraph, FunctionInfo, GraphEdge, GraphNode } from "./types.ts";

/**
 * Resolve `api.<rel>.<name>` chains to a definition key, following barrel
 * re-exports (`export { foo } from "./sub"`, `export { foo as bar } from "./sub"`,
 * `export * from "./sub"`). Mirrors the resolution scan.ts does for `returns`
 * shapes — without it, every barrel-routed call is mis-attributed and the
 * underlying definition looks dead.
 */
function resolveChain(
  relPath: string,
  exportName: string,
  nodes: Map<string, GraphNode>,
  project: Project,
  convexDir: string,
  visited: Set<string>,
): string | null {
  for (const candidate of [relPath, `${relPath}/index`]) {
    const key = `${candidate}:${exportName}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (nodes.has(key)) return key;

    const sf =
      project.getSourceFile(`${convexDir}/${candidate}.ts`) ||
      project.getSourceFile(`${convexDir}/${candidate}.tsx`);
    if (!sf) continue;

    for (const ed of sf.getExportDeclarations()) {
      const moduleSpec = ed.getModuleSpecifierValue();
      if (!moduleSpec || !moduleSpec.startsWith(".")) continue;
      const targetSf = ed.getModuleSpecifierSourceFile();
      if (!targetSf) continue;
      const targetRel = pathRelative(
        convexDir,
        targetSf.getFilePath(),
      ).replace(/\.tsx?$/, "");

      const named = ed.getNamedExports();
      if (named.length === 0) {
        // `export * from "./x"` — same name lives in the target module.
        const found = resolveChain(targetRel, exportName, nodes, project, convexDir, visited);
        if (found) return found;
        continue;
      }
      for (const ne of named) {
        const aliasNode = ne.getAliasNode();
        const exportedAs = (aliasNode ?? ne.getNameNode()).getText();
        if (exportedAs !== exportName) continue;
        const localName = ne.getNameNode().getText();
        const found = resolveChain(targetRel, localName, nodes, project, convexDir, visited);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Build a call graph for every Convex function. Walks `projectRoot` looking
 * for property-access chains rooted at `api` or `internal`, then matches
 * each chain to a known function definition. Caller resolution:
 *   - If the reference lives inside a `handler:` of a Convex function in
 *     `convexDir`, the caller is that function.
 *   - Otherwise the caller is a synthetic `external:<relpath>` node — used
 *     for React hooks (`useQuery(api.x.y)`), crons, fetchQuery, etc.
 *
 * Besides `api.x.y` chains, string literals of the form `"path/to/file:fn"`
 * that resolve to a known function count as references too — they're how
 * `npx convex run`, `ConvexHttpClient#query(name)`, and fixture inventories
 * invoke functions by name.
 *
 * Dead = unreachable from every external caller. A reference from a function
 * that is itself dead (or a self-call) does not keep its target alive — so
 * whole orphaned clusters (dead entry point + its private helpers) are
 * reported in one pass instead of surfacing layer-by-layer as you delete.
 * Nodes matched by `--ignore-dead` or carrying a `convex-doctor: keep`
 * comment are treated as live roots: they're excluded from the dead list AND
 * everything they call stays alive.
 */
export interface BuildGraphInput {
  convexDir: string;
  projectRoot: string;
  functions: FunctionInfo[];
  /** Glob patterns (`*` only). Nodes whose id matches any are excluded
   *  from the dead list, flagged `ignored` for the renderer, and treated
   *  as live roots (their callees stay alive). */
  ignoreDead?: string[];
}

function compilePatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns?.length) return [];
  return patterns.map((p) => {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  });
}

export function buildGraph(input: BuildGraphInput): CallGraph {
  const ignorePatterns = compilePatterns(input.ignoreDead);
  const isIgnored = (id: string): boolean =>
    ignorePatterns.some((re) => re.test(id));
  const convexDir = pathResolve(input.convexDir);
  const projectRoot = pathResolve(input.projectRoot);

  // Index every function by its API path key.
  // key = "<relPathUnderConvex>:<exportName>"  e.g. "charges/queries:list"
  // Also map "<relPath>/index:export" when the file is index.ts.
  const nodes = new Map<string, GraphNode>();
  for (const fn of input.functions) {
    const id = fnId(convexDir, fn);
    if (!id) continue;
    nodes.set(id, {
      id,
      exportName: fn.exportName,
      filePath: fn.filePath,
      line: fn.line,
      kind: fn.kind,
      incoming: 0,
      outgoing: 0,
      ...(fn.keep ? { kept: true } : {}),
    });
  }
  // Fresh ts-morph project covering the whole repo for caller discovery.
  // We deliberately exclude generated / vendored / build output so the walk
  // stays fast on large monorepos.
  const project = new Project({
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, noEmit: true, target: 99 },
  });
  project.addSourceFilesAtPaths([
    `${projectRoot}/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
    // `**` never matches a dotted path segment, but agent-era repos keep real
    // callers under dot-directories — .claude/skills scripts, .github workflow
    // scripts. Match dot-dirs explicitly (`{,**/}` = at the root or anywhere
    // below); the vcs/build dot-dirs are excluded right after.
    `${projectRoot}/{,**/}.*/**/*.{ts,tsx,js,jsx,mjs,cjs}`,
    `!${projectRoot}/**/node_modules/**`,
    `!${projectRoot}/{,**/}.*/**/node_modules/**`,
    `!${projectRoot}/{,**/}.{git,next,turbo,vercel,wrangler,cache}/**`,
    `!${projectRoot}/**/dist/**`,
    `!${projectRoot}/**/build/**`,
    `!${projectRoot}/**/coverage/**`,
    // Skip Convex's top-level codegen — it has no api.x/internal.x chains
    // anyway, but excluding keeps the file count honest. Sub-package
    // codegen (e.g. calabasas/_generated/sync.ts) IS included because
    // it does call its own internalMutations via internal.x.y chains.
    `!${convexDir}/_generated/**`,
  ]);

  const edges: GraphEdge[] = [];
  const externals = new Map<string, { id: string; filePath: string; outgoing: number }>();
  const dedupe = new Set<string>(); // `${from}→${to}@${line}`

  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    const addEdge = (refNode: Node, id: string, via: string): void => {
      const callerId = enclosingCallerId(refNode, convexDir, nodes) ??
        externalId(fp, projectRoot);
      const line = refNode.getStartLineNumber();
      const dedupeKey = `${callerId}→${id}@${fp}:${line}`;
      if (dedupe.has(dedupeKey)) return;
      dedupe.add(dedupeKey);

      edges.push({ from: callerId, to: id, filePath: fp, line, via });

      const tgt = nodes.get(id);
      if (tgt) tgt.incoming += 1;

      const callerNode = nodes.get(callerId);
      if (callerNode) {
        callerNode.outgoing += 1;
      } else if (callerId.startsWith("external:")) {
        const ext = externals.get(callerId) ?? {
          id: callerId,
          filePath: fp,
          outgoing: 0,
        };
        ext.outgoing += 1;
        externals.set(callerId, ext);
      }
    };

    // Don't double-count the function's own definition site as a self-call.
    // (definitions don't reference `api.x.y` to themselves, but be safe.)
    sf.forEachDescendant((node) => {
      // `"path/to/file:fn"` string literals — `npx convex run` in scripts,
      // ConvexHttpClient#query(name), fixture inventories. Only strings that
      // resolve to a known definition (barrels included) become edges, so
      // ordinary prose containing a colon can't create phantom references.
      if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.getLiteralText();
        if (!STRING_REF_RE.test(text)) return;
        const [relPath, exportName] = text.split(":") as [string, string];
        const id = resolveChain(relPath, exportName, nodes, project, convexDir, new Set());
        if (id) addEdge(node, id, "string-ref");
        return;
      }
      // Identifier `api`, `internal`, or `anyApi` (the untyped reference
      // builder from "convex/server", used by external scripts that can't
      // import _generated) is the root of every chain we care about.
      if (!Node.isIdentifier(node)) return;
      const text = node.getText();
      if (text !== "api" && text !== "internal" && text !== "anyApi") return;
      // Skip the import declaration itself (`import { api } from ...`).
      if (insideImportDecl(node)) return;
      const chain = readChain(node);
      if (!chain) return;
      const id = lookupNode(chain, nodes, project, convexDir);
      if (!id) return;
      addEdge(node, id, detectVia(node));
    });
  }

  const nodeArr = [...nodes.values()];
  for (const n of nodeArr) {
    if (isIgnored(n.id)) n.ignored = true;
  }

  // Dead = unreachable from any live root. Roots are the external caller
  // pseudo-nodes plus every ignored/kept node (declared alive, so whatever
  // they call must survive too). Walking reachability instead of testing
  // `incoming === 0` means edges from dead functions — including self-calls,
  // e.g. a paged migration that re-schedules itself — grant no life.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.from);
    if (list) list.push(e.to);
    else adjacency.set(e.from, [e.to]);
  }
  const stack = [
    ...externals.keys(),
    ...nodeArr.filter((n) => n.ignored || n.kept).map((n) => n.id),
  ];
  const reachable = new Set<string>(stack);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }
  const deadNodes = nodeArr.filter((n) => !reachable.has(n.id));
  const dead = deadNodes.map((n) => n.id);
  const deadTransitive = deadNodes.filter((n) => n.incoming > 0).map((n) => n.id);

  return {
    nodes: nodeArr,
    externals: [...externals.values()],
    edges,
    dead,
    deadTransitive,
    scannedFiles: project.getSourceFiles().length,
  };
}

/** Shape of a string function reference: `<relPath>:<exportName>`, where the
 *  path may contain `/` segments. Kept tight so arbitrary colon-bearing
 *  strings (URLs, times, prose) are rejected before any resolution work. */
const STRING_REF_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$/.-]*:[A-Za-z0-9_$]+$/;

function fnId(convexDir: string, fn: FunctionInfo): string | null {
  const rel = pathRelative(convexDir, fn.filePath).replace(/\.tsx?$/, "");
  if (rel.startsWith("..")) return null;
  return `${rel}:${fn.exportName}`;
}

function externalId(filePath: string, projectRoot: string): string {
  return `external:${pathRelative(projectRoot, filePath)}`;
}

/**
 * Walk up from the root `api`/`internal` identifier through chained
 * PropertyAccessExpressions and return the dotted segments.
 * `api.foo.bar.baz` → `["foo", "bar", "baz"]`.
 */
function readChain(rootId: Node): string[] | null {
  let parent = rootId.getParent();
  if (!parent || !Node.isPropertyAccessExpression(parent)) return null;
  if (parent.getExpression() !== rootId) return null;
  const segments: string[] = [];
  let current: Node = parent;
  while (Node.isPropertyAccessExpression(current)) {
    segments.push(current.getName());
    const next = current.getParent();
    if (!next || !Node.isPropertyAccessExpression(next)) break;
    if (next.getExpression() !== current) break;
    current = next;
  }
  return segments.length === 0 ? null : segments;
}

function lookupNode(
  segments: string[],
  nodes: Map<string, GraphNode>,
  project: Project,
  convexDir: string,
): string | null {
  if (segments.length === 0) return null;
  const exportName = segments[segments.length - 1]!;
  const relPath = segments.slice(0, -1).join("/");
  return resolveChain(relPath, exportName, nodes, project, convexDir, new Set());
}

function insideImportDecl(node: Node): boolean {
  let p: Node | undefined = node.getParent();
  while (p) {
    if (Node.isImportDeclaration(p) || Node.isImportSpecifier(p)) return true;
    p = p.getParent();
  }
  return false;
}

/**
 * Climb the parent chain. If we find a `handler:` PropertyAssignment whose
 * enclosing VariableDeclaration is a registered Convex function, return
 * that function's id — otherwise null (external caller).
 */
function enclosingCallerId(
  node: Node,
  convexDir: string,
  nodes: Map<string, GraphNode>,
): string | null {
  const filePath = node.getSourceFile().getFilePath();
  if (!filePath.startsWith(convexDir)) return null;

  let p: Node | undefined = node.getParent();
  while (p) {
    if (Node.isVariableDeclaration(p)) {
      const name = p.getName();
      const init = p.getInitializer();
      // Must be `export const x = query/mutation/.../action({...})` to count.
      if (init && Node.isCallExpression(init)) {
        const candidate = `${stripConvexRel(filePath, convexDir)}:${name}`;
        if (nodes.has(candidate)) return candidate;
      }
    }
    p = p.getParent();
  }
  return null;
}

function stripConvexRel(filePath: string, convexDir: string): string {
  return pathRelative(convexDir, filePath).replace(/\.tsx?$/, "");
}

/**
 * Best-effort label for the edge: the immediate function name invoking
 * the reference (`useQuery`, `runQuery`, `fetchQuery`, …) or `ref` if
 * the reference is passed as data (e.g. `crons.daily("x", { hours: 1 }, internal.x.y)`).
 */
function detectVia(rootId: Node): string {
  // Walk up to the end of the PropertyAccessExpression chain.
  let top: Node = rootId;
  let parent = top.getParent();
  while (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === top) {
    top = parent;
    parent = top.getParent();
  }
  if (!parent) return "ref";
  // `foo(api.x.y, ...)` — parent is CallExpression, top is an argument.
  if (Node.isCallExpression(parent)) {
    const callee = parent.getExpression();
    if (Node.isIdentifier(callee)) return callee.getText();
    if (Node.isPropertyAccessExpression(callee)) return callee.getName();
    return "call";
  }
  return "ref";
}
