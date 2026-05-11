export { run } from "./scan.ts";
export { reportText, reportJson, exitCode } from "./report.ts";
export { reportHtml } from "./html.ts";
export { buildGraph } from "./graph.ts";
export type {
  RunOptions,
  RunResult,
  Issue,
  IssueSeverity,
  CallGraph,
  GraphNode,
  GraphEdge,
  FunctionInfo,
} from "./types.ts";
