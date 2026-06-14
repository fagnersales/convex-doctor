export { run } from "./scan.ts";
export { reportText, reportJson, exitCode } from "./report.ts";
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
