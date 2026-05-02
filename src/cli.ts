#!/usr/bin/env bun
import { run } from "./scan.ts";
import { reportText, reportJson, exitCode } from "./report.ts";
import type { RunOptions } from "./types.ts";

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
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

process.exit(exitCode(result, opts.strict));
