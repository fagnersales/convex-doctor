#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { run } from "./scan.ts";
import { reportText, reportJson, exitCode } from "./report.ts";
import { reportHtml } from "./html.ts";
import type { RunOptions } from "./types.ts";

interface CliOptions extends RunOptions {
  htmlOut?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    convexDir: "convex",
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "text",
    strict: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--convex-dir":
        opts.convexDir = argv[++i] ?? opts.convexDir;
        break;
      case "--schema":
        opts.schemaPath = argv[++i];
        break;
      case "--include-unanalyzed":
        opts.includeUnanalyzed = true;
        break;
      case "--json":
        opts.format = "json";
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--html":
        opts.htmlOut = argv[++i];
        opts.buildGraph = true;
        break;
      case "--project-root":
        opts.projectRoot = argv[++i];
        break;
      case "--ignore-dead": {
        const pat = argv[++i];
        if (pat) (opts.ignoreDead ??= []).push(pat);
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a?.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }

  return opts;
}

function printHelp() {
  process.stdout.write(`check-convex-validators

Static analyzer for ReturnsValidationError drift in Convex codebases.

Usage:
  check-convex-validators [options]

Options:
  --convex-dir <path>      Path to convex/ directory. Default: convex
  --schema <path>          Path to schema.ts. Default: <convex-dir>/schema.ts
  --include-unanalyzed     Print INFO entries for handlers that couldn't be statically analyzed
  --json                   Emit JSON instead of text
  --strict                 Exit nonzero if any warnings are present
  --html <path>            Also write a self-contained call-graph HTML
  --project-root <path>    Root scanned for callers when --html is set.
                           Default: parent of <convex-dir>
  --ignore-dead <pattern>  Glob pattern (`*` wildcard) excluding nodes
                           from the dead list. Repeatable.
                           Examples: 'migrations:*', '*:migrate*'
  -h, --help               Show this help

Exit codes:
  0  No errors (and no warnings if --strict)
  1  Errors found (or warnings under --strict)
  2  Bad arguments
`);
}

const opts = parseArgs(process.argv.slice(2));
const result = run(opts);

if (opts.format === "json") {
  process.stdout.write(reportJson(result) + "\n");
} else {
  process.stdout.write(reportText(result));
}

if (opts.htmlOut && result.graph) {
  const html = reportHtml(result.graph, result.functions, {
    convexDir: opts.convexDir,
    projectRoot: opts.projectRoot ?? `${opts.convexDir}/..`,
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(opts.htmlOut, html);
  const g = result.graph;
  process.stdout.write(
    `\nWrote ${opts.htmlOut} — ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.dead.length} dead (scanned ${g.scannedFiles} files).\n`,
  );
}

process.exit(exitCode(result, opts.strict));
