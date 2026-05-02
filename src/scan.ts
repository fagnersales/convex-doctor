import { Project, Node, SyntaxKind, type SourceFile, type CallExpression } from "ts-morph";
import { parseSchema } from "./schema.ts";
import { parseValidator, resolveRef } from "./validator.ts";
import { analyzeHandler } from "./handler.ts";
import { matchFunction } from "./match.ts";
import type { FunctionInfo, Issue, RunOptions, RunResult, Shape } from "./types.ts";

const FUNCTION_KINDS = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
]);

export function run(opts: RunOptions): RunResult {
  const project = new Project({
    tsConfigFilePath: undefined,
    compilerOptions: { allowJs: false, noEmit: true, target: 99 },
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
  });

  const convexDir = opts.convexDir.replace(/\/$/, "");
  project.addSourceFilesAtPaths([
    `${convexDir}/**/*.ts`,
    `!${convexDir}/_generated/**/*`,
    `!${convexDir}/**/*.test.ts`,
    `!${convexDir}/**/_test/**/*`,
  ]);

  const schemaPath = opts.schemaPath ?? `${convexDir}/schema.ts`;
  const schemaFile = project.getSourceFile(schemaPath);
  if (!schemaFile) {
    return {
      issues: [
        {
          severity: "error",
          code: "UNANALYZED",
          filePath: schemaPath,
          line: 0,
          function: "<schema>",
          message: `Schema file not found at ${schemaPath}`,
        },
      ],
      scannedFunctions: 0,
      schema: { tables: new Map() },
    };
  }

  const schema = parseSchema(schemaFile, project);
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

  // Pass 2: classify handlers with the run-call resolver wired up.
  const resolveRunCall = (segments: string[]): Shape | null => {
    if (segments.length < 1) return null;
    const exportName = segments[segments.length - 1]!;
    const relPath = segments.slice(0, -1).join("/");
    // try `<relPath>` (file) or fall back to `<relPath>/index`
    for (const candidate of [relPath, `${relPath}/index`]) {
      const key = `${candidate}:${exportName}`;
      const shape = returnsByPath.get(key);
      if (shape) return shape;
    }
    return null;
  };

  for (const p of pending) {
    if (!Node.isArrowFunction(p.handlerNode) && !Node.isFunctionExpression(p.handlerNode)) {
      continue;
    }
    const intents = analyzeHandler(p.handlerNode, {
      argsShape: p.argsShape,
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
    scanned += 1;
    allIssues.push(...matchFunction(fn, schema));
  }

  return { issues: filterIssues(allIssues, opts), scannedFunctions: scanned, schema };
}

function pendingKey(convexDir: string, filePath: string, exportName: string): string {
  // Strip convexDir prefix and `.ts` suffix to get the relative module path.
  const dir = convexDir.endsWith("/") ? convexDir : `${convexDir}/`;
  let rel = filePath.startsWith(dir) ? filePath.slice(dir.length) : filePath;
  rel = rel.replace(/\.tsx?$/, "");
  return `${rel}:${exportName}`;
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
