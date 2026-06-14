import { Project, Node, SyntaxKind, type SourceFile, type CallExpression } from "ts-morph";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { parseSchema } from "./schema.ts";
import { parseValidator, resolveRef } from "./validator.ts";
import { analyzeHandler } from "./handler.ts";
import { matchFunction } from "./match.ts";
import { buildGraph } from "./graph.ts";
import { summarize } from "./report.ts";
import { makeIssue } from "./rules.ts";
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
  if (!schemaFile) {
    const issues = [
      makeIssue("ANALYZER_ERROR", {
        severity: "error",
        filePath: schemaPath,
        line: 0,
        function: "<schema>",
        message: `Schema file not found at ${schemaPath}. Pass --schema <path> or --convex-dir <path> if your schema lives elsewhere.`,
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

  const schema = parseSchema(schemaFile, project);
  const tSchema = performance.now();
  const allIssues: Issue[] = [];
  let scanned = 0;

  // Pass 1: collect function metadata (returns shapes, args shapes, handler nodes).
  // We need this before pass 2 so that handler analysis can resolve cross-file
  // `ctx.runQuery(internal.x.y, ...)` targets.
  const pending: Pending[] = [];
  const returnsByPath = new Map<string, Shape>(); // "<relpath>:<exportName>" → shape

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath() === schemaFile.getFilePath()) continue;
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
    if (!Node.isArrowFunction(p.handlerNode) && !Node.isFunctionExpression(p.handlerNode)) {
      continue;
    }
    // Isolate analysis per function: a single pathological handler must never
    // crash the whole run or silently drop out of the report. (C10)
    try {
      const intents = analyzeHandler(p.handlerNode, {
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

  const issues = filterIssues(allIssues, opts);
  return {
    issues,
    scannedFunctions: scanned,
    schema,
    timings,
    graph,
    functions: collected,
    summary: summarize(issues, scanned),
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
};

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
      });
    }
  }

  return out;
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
