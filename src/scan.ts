import { Project, Node, SyntaxKind, type SourceFile, type CallExpression } from "ts-morph";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { parseSchema } from "./schema.ts";
import { parseValidator, resolveRef } from "./validator.ts";
import { analyzeHandler, type HandlerFn } from "./handler.ts";
import { matchFunction } from "./match.ts";
import { buildGraph } from "./graph.ts";
import { summarize } from "./report.ts";
import { makeIssue } from "./rules.ts";
import { lintProject } from "./lint.ts";
import type {
  CallGraph,
  FunctionInfo,
  Issue,
  RunOptions,
  RunResult,
  Shape,
  Timings,
} from "./types.ts";

const FUNCTION_KINDS = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

export function run(opts: RunOptions): RunResult {
  const t0 = performance.now();
  const project = new Project({
    tsConfigFilePath: undefined,
    compilerOptions: { allowJs: false, noEmit: true, target: 99 },
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
  });

  // Resolve convexDir to absolute so cross-file run-call resolution can
  // strip the prefix from `SourceFile#getFilePath()` (which is absolute).
  const convexDir = pathResolve(opts.convexDir.replace(/\/$/, ""));
  project.addSourceFilesAtPaths([
    `${convexDir}/**/*.ts`,
    `!${convexDir}/_generated/**/*`,
    `!${convexDir}/**/*.test.ts`,
    `!${convexDir}/**/_test/**/*`,
  ]);
  const tFileLoad = performance.now();

  const schemaPath = opts.schemaPath ?? `${convexDir}/schema.ts`;
  const schemaFile = project.getSourceFile(schemaPath);
  // Schema is OPTIONAL in Convex. Only treat a missing schema as a hard error
  // when there are NO Convex source files at all — that's almost always a wrong
  // --convex-dir/--schema path. A dir with function files but no schema.ts is a
  // valid *schemaless* project (common in quick / AI-generated apps): analyze it
  // against an empty, permissive schema. Returns validators backed by
  // literal/primitive/explicit shapes are still checked; db-backed reads can't
  // resolve a row shape without a schema, so they conservatively degrade to
  // UNANALYZED rather than erroring out the whole run.
  if (!schemaFile && project.getSourceFiles().length === 0) {
    const issues = [
      makeIssue("ANALYZER_ERROR", {
        severity: "error",
        filePath: schemaPath,
        line: 0,
        function: "<schema>",
        message: `No Convex source files found under ${convexDir} (and no schema at ${schemaPath}). Pass --convex-dir <path> or --schema <path> if your code lives elsewhere.`,
      }),
    ];
    return {
      issues,
      scannedFunctions: 0,
      schema: { tables: new Map() },
      timings: zeroTimings(t0, tFileLoad, project.getSourceFiles().length),
      functions: [],
      summary: summarize(issues, 0),
    };
  }

  const schema = schemaFile ? parseSchema(schemaFile, project) : { tables: new Map() };
  const tSchema = performance.now();
  const allIssues: Issue[] = [];
  let scanned = 0;

  // Pass 1: collect function metadata (returns shapes, args shapes, handler nodes).
  // We need this before pass 2 so that handler analysis can resolve cross-file
  // `ctx.runQuery(internal.x.y, ...)` targets.
  const pending: Pending[] = [];
  const returnsByPath = new Map<string, Shape>(); // "<relpath>:<exportName>" → shape

  for (const sf of project.getSourceFiles()) {
    if (schemaFile && sf.getFilePath() === schemaFile.getFilePath()) continue;
    for (const p of collectPending(sf, project)) {
      pending.push(p);
      if (p.returnsValidator) {
        const key = pendingKey(convexDir, p.sf.getFilePath(), p.decl.getName());
        returnsByPath.set(key, p.returnsValidator);
      }
    }
  }
  const tCollect = performance.now();

  // Pass 2: classify handlers with the run-call resolver wired up.
  // Resolves direct-defined exports first, then walks re-export chains
  // (`export { x } from "./y"`) for barrel-style modules.
  const resolveByRelPath = (
    relPath: string,
    exportName: string,
    visited: Set<string>,
  ): Shape | null => {
    for (const candidate of [relPath, `${relPath}/index`]) {
      const key = `${candidate}:${exportName}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const direct = returnsByPath.get(key);
      if (direct) return direct;

      // No direct definition — peek at the source file's re-exports.
      const sf = project.getSourceFile(`${convexDir}/${candidate}.ts`);
      if (!sf) continue;
      for (const ed of sf.getExportDeclarations()) {
        const moduleSpec = ed.getModuleSpecifierValue();
        if (!moduleSpec || !moduleSpec.startsWith(".")) continue;
        const targetSf = ed.getModuleSpecifierSourceFile();
        if (!targetSf) continue;
        const targetRel = stripConvexPrefix(
          targetSf.getFilePath().replace(/\.tsx?$/, ""),
          convexDir,
        );
        for (const ne of ed.getNamedExports()) {
          const aliasNode = ne.getAliasNode();
          const exportedAs = (aliasNode ?? ne.getNameNode()).getText();
          if (exportedAs !== exportName) continue;
          const localName = ne.getNameNode().getText();
          const found = resolveByRelPath(targetRel, localName, visited);
          if (found) return found;
        }
      }
    }
    return null;
  };
  const resolveRunCall = (segments: string[]): Shape | null => {
    if (segments.length < 1) return null;
    const exportName = segments[segments.length - 1]!;
    const relPath = segments.slice(0, -1).join("/");
    return resolveByRelPath(relPath, exportName, new Set());
  };

  const collected: FunctionInfo[] = [];
  for (const p of pending) {
    // Resolve the handler to an analyzable function. A `handler:` value is often
    // NOT an inline arrow — components commonly factor the body out as
    // `handler: fooHandler` (a named reference). Following that reference instead
    // of skipping it is essential: a silently-skipped handler is never checked
    // AND never reported, so a returns-validated function with real drift would
    // pass invisibly. (Found by the sensitivity audit on aggregate / launchdarkly
    // / rag.)
    const handlerFn = resolveHandlerFn(p.handlerNode);
    if (!handlerFn) {
      // Couldn't follow it (e.g. a wrapped `customQuery(...)` handler). Don't
      // drop it silently — mark UNANALYZED so coverage stays honest. matchFunction
      // emits nothing when there's no returns validator, so this adds no noise.
      const fn: FunctionInfo = {
        filePath: p.sf.getFilePath(),
        line: p.decl.getStartLineNumber(),
        exportName: p.decl.getName(),
        kind: p.fnKind,
        returnsValidator: p.returnsValidator,
        returnsValidatorLine: p.returnsLine,
        intents: [{ kind: "unanalyzed", reason: "handler is not an inline or resolvable named function" }],
        keep: p.keep,
      };
      collected.push(fn);
      scanned += 1;
      allIssues.push(...matchFunction(fn, schema));
      continue;
    }
    // Isolate analysis per function: a single pathological handler must never
    // crash the whole run or silently drop out of the report. (C10)
    try {
      const intents = analyzeHandler(handlerFn, {
        argsShape: p.argsShape,
        schema,
        resolveRunCall,
      });
      const fn: FunctionInfo = {
        filePath: p.sf.getFilePath(),
        line: p.decl.getStartLineNumber(),
        exportName: p.decl.getName(),
        kind: p.fnKind,
        returnsValidator: p.returnsValidator,
        returnsValidatorLine: p.returnsLine,
        intents,
        keep: p.keep,
      };
      collected.push(fn);
      scanned += 1;
      allIssues.push(...matchFunction(fn, schema));
    } catch (err) {
      scanned += 1;
      allIssues.push(
        makeIssue("ANALYZER_ERROR", {
          severity: "error",
          filePath: p.sf.getFilePath(),
          line: p.decl.getStartLineNumber(),
          function: p.decl.getName(),
          message: `Analyzer threw while processing this function — it was skipped`,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  const tAnalyze = performance.now();

  // Best-practice / lint pass — opt-in via RunOptions.lint (CLI defaults it on).
  // Independent of the drift pipeline; runs over the same loaded source files.
  if (opts.lint) {
    try {
      allIssues.push(
        ...lintProject({
          sourceFiles: project.getSourceFiles(),
          schemaFilePath: schemaFile?.getFilePath(),
        }),
      );
    } catch (err) {
      allIssues.push(
        makeIssue("ANALYZER_ERROR", {
          severity: "warn",
          filePath: convexDir,
          line: 0,
          function: "<lint>",
          message: `Lint pass threw and was skipped`,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  let graph: CallGraph | undefined;
  if (opts.buildGraph) {
    const projectRoot = pathResolve(opts.projectRoot ?? pathDirname(convexDir));
    graph = buildGraph({
      convexDir,
      projectRoot,
      functions: collected,
      ignoreDead: opts.ignoreDead,
    });
  }

  const timings: Timings = {
    fileLoadMs: round(tFileLoad - t0),
    schemaParseMs: round(tSchema - tFileLoad),
    collectMs: round(tCollect - tSchema),
    analyzeMs: round(tAnalyze - tCollect),
    totalMs: round(tAnalyze - t0),
    filesLoaded: project.getSourceFiles().length,
  };

  const { visible, suppressed } = applySuppressions(filterIssues(allIssues, opts), project);
  return {
    issues: visible,
    scannedFunctions: scanned,
    schema,
    timings,
    graph,
    functions: collected,
    summary: summarize(visible, scanned),
    ...(suppressed.length > 0 ? { suppressed } : {}),
  };
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function zeroTimings(t0: number, tLoad: number, files: number): Timings {
  return {
    fileLoadMs: round(tLoad - t0),
    schemaParseMs: 0,
    collectMs: 0,
    analyzeMs: 0,
    totalMs: round(performance.now() - t0),
    filesLoaded: files,
  };
}

function pendingKey(convexDir: string, filePath: string, exportName: string): string {
  return `${stripConvexPrefix(filePath.replace(/\.tsx?$/, ""), convexDir)}:${exportName}`;
}

function stripConvexPrefix(path: string, convexDir: string): string {
  const dir = convexDir.endsWith("/") ? convexDir : `${convexDir}/`;
  return path.startsWith(dir) ? path.slice(dir.length) : path;
}

/**
 * `// convex-doctor: ignore <CODE>[, <CODE>…] — reason` on the flagged line
 * (trailing) or the line directly above it silences that finding — the lint
 * counterpart of the dead-code `keep` comment. Codes are explicit and
 * case-insensitive; there is deliberately no bare blanket `ignore`, so a new
 * issue of a different code on the same line still surfaces. Suppressed issues
 * drop out of the report, groups, and the exit code, but are returned under
 * `RunResult.suppressed` so reports can say how many were muted.
 */
const IGNORE_DIRECTIVE = /convex-doctor:\s*ignore\s+([A-Za-z0-9_,\s]+)/i;

function ignoredCodesOn(lineText: string | undefined): Set<string> | null {
  if (!lineText) return null;
  const m = IGNORE_DIRECTIVE.exec(lineText);
  if (!m) return null;
  const codes = m[1]
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return codes.length > 0 ? new Set(codes) : null;
}

function applySuppressions(
  issues: Issue[],
  project: Project,
): { visible: Issue[]; suppressed: Issue[] } {
  const visible: Issue[] = [];
  const suppressed: Issue[] = [];
  const lineCache = new Map<string, string[] | null>();

  const linesFor = (filePath: string): string[] | null => {
    let lines = lineCache.get(filePath);
    if (lines === undefined) {
      lines = project.getSourceFile(filePath)?.getFullText().split(/\r?\n/) ?? null;
      lineCache.set(filePath, lines);
    }
    return lines;
  };

  for (const issue of issues) {
    const lines = issue.line > 0 ? linesFor(issue.filePath) : null;
    if (lines) {
      // 1-based issue.line → lines[line - 1] is the flagged line itself,
      // lines[line - 2] the line directly above it.
      const onLine = ignoredCodesOn(lines[issue.line - 1]);
      const above = issue.line > 1 ? ignoredCodesOn(lines[issue.line - 2]) : null;
      if (onLine?.has(issue.code) || above?.has(issue.code)) {
        suppressed.push(issue);
        continue;
      }
    }
    visible.push(issue);
  }
  return { visible, suppressed };
}

function filterIssues(issues: Issue[], opts: RunOptions): Issue[] {
  return issues.filter((i) => {
    if (i.code === "UNANALYZED" && !opts.includeUnanalyzed) return false;
    return true;
  });
}

type Pending = {
  sf: SourceFile;
  decl: import("ts-morph").VariableDeclaration;
  fnKind: FunctionInfo["kind"];
  returnsValidator: Shape | null;
  returnsLine: number;
  handlerNode: Node;
  argsShape: Map<string, import("./types.ts").FieldShape> | undefined;
  keep: boolean;
};

/**
 * `// convex-doctor: keep` (or the same inside a block/JSDoc comment) on the
 * line(s) above an export marks it as externally invoked — `npx convex run`,
 * a cron in another repo, a webhook — so dead-function detection must treat
 * it as alive. The directive is matched strictly (`convex-doctor: keep`) so
 * prose that merely mentions the tool can't accidentally suppress a finding.
 */
const KEEP_DIRECTIVE = /convex-doctor:\s*keep\b/i;

function hasKeepComment(stmt: Node): boolean {
  return stmt.getLeadingCommentRanges().some((r) => KEEP_DIRECTIVE.test(r.getText()));
}

function collectPending(sf: SourceFile, project: Project): Pending[] {
  const out: Pending[] = [];

  for (const stmt of sf.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue;
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (!init || !Node.isCallExpression(init)) continue;
      const fnKind = getFunctionKind(init);
      if (!fnKind) continue;
      const cfg = init.getArguments()[0];
      if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;

      let returnsValidator: Shape | null = null;
      let returnsLine = decl.getStartLineNumber();
      let handlerNode: Node | null = null;
      let argsShapeMap: Map<string, import("./types.ts").FieldShape> | undefined;

      for (const prop of cfg.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        const name = prop.getName();
        if (name === "returns") {
          const propInit = prop.getInitializer();
          if (propInit) {
            returnsValidator = resolveRef(parseValidator(propInit), sf, project);
            returnsLine = prop.getStartLineNumber();
          }
        } else if (name === "handler") {
          handlerNode = prop.getInitializer() ?? null;
        } else if (name === "args") {
          const propInit = prop.getInitializer();
          if (propInit) {
            const shape = resolveRef(parseValidator(propInit), sf, project);
            if (shape.kind === "object") argsShapeMap = shape.fields;
          }
        }
      }

      if (!handlerNode) continue;
      out.push({
        sf,
        decl,
        fnKind,
        returnsValidator,
        returnsLine,
        handlerNode,
        argsShape: argsShapeMap,
        keep: hasKeepComment(stmt),
      });
    }
  }

  return out;
}

/**
 * Resolve a `handler:` value to an analyzable function. Inline arrows /
 * function-expressions are returned directly; a named reference
 * (`handler: fooHandler`) is followed to its declaration — a `const fooHandler =
 * async (...) => {...}` or `function fooHandler(...) {...}`, including imports
 * across files (ts-morph getDefinitionNodes resolves them). Returns null for
 * anything we can't follow statically (e.g. a wrapped `customQuery(...)` call),
 * so the caller can record honest UNANALYZED coverage instead of silently
 * dropping the function.
 */
function resolveHandlerFn(node: Node): HandlerFn | null {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isFunctionDeclaration(node) && node.getBody()) return node;
  if (Node.isIdentifier(node)) {
    let defs: Node[] = [];
    try {
      defs = node.getDefinitionNodes();
    } catch {
      defs = [];
    }
    for (const d of defs) {
      if (Node.isFunctionDeclaration(d) && d.getBody()) return d;
      if (Node.isVariableDeclaration(d)) {
        const init = d.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          return init;
        }
      }
    }
  }
  return null;
}

function getFunctionKind(call: CallExpression): FunctionInfo["kind"] | null {
  const expr = call.getExpression();
  let name: string | null = null;
  if (Node.isIdentifier(expr)) name = expr.getText();
  else if (Node.isPropertyAccessExpression(expr)) name = expr.getName();
  if (!name) return null;
  if (!FUNCTION_KINDS.has(name)) return null;
  return name as FunctionInfo["kind"];
}
