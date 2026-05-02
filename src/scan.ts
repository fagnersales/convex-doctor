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

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath() === schemaFile.getFilePath()) continue;
    const fns = collectFunctions(sf, project);
    scanned += fns.length;
    for (const fn of fns) {
      allIssues.push(...matchFunction(fn, schema));
    }
  }

  return { issues: filterIssues(allIssues, opts), scannedFunctions: scanned, schema };
}

function filterIssues(issues: Issue[], opts: RunOptions): Issue[] {
  return issues.filter((i) => {
    if (i.code === "UNANALYZED" && !opts.includeUnanalyzed) return false;
    return true;
  });
}

function collectFunctions(sf: SourceFile, project: Project): FunctionInfo[] {
  const fns: FunctionInfo[] = [];

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
          const init = prop.getInitializer();
          if (init) {
            returnsValidator = resolveRef(parseValidator(init), sf, project);
            returnsLine = prop.getStartLineNumber();
          }
        } else if (name === "handler") {
          handlerNode = prop.getInitializer() ?? null;
        } else if (name === "args") {
          const init = prop.getInitializer();
          if (init) {
            const shape = resolveRef(parseValidator(init), sf, project);
            if (shape.kind === "object") argsShapeMap = shape.fields;
          }
        }
      }

      if (!handlerNode) continue;
      if (!Node.isArrowFunction(handlerNode) && !Node.isFunctionExpression(handlerNode)) continue;

      const intents = analyzeHandler(handlerNode, { argsShape: argsShapeMap });

      fns.push({
        filePath: sf.getFilePath(),
        line: decl.getStartLineNumber(),
        exportName: decl.getName(),
        kind: fnKind,
        returnsValidator,
        returnsValidatorLine: returnsLine,
        intents,
      });
    }
  }

  return fns;
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
