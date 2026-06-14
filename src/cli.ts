#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { run } from "./scan.ts";
import { reportText, reportJson, exitCode } from "./report.ts";
import { reportHtml } from "./html.ts";
import { reportLintHtml, LINT_CODES } from "./lintHtml.ts";
import type { RunOptions } from "./types.ts";

interface CliOptions extends RunOptions {
  htmlOut?: string;
  lintHtmlOut?: string;
  printDead?: boolean;
  deadOnly?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    convexDir: "convex",
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "text",
    strict: false,
    lint: true,
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
      case "--no-lint":
        opts.lint = false;
        break;
      case "--lint":
        opts.lint = true;
        break;
      case "--html":
        opts.htmlOut = argv[++i];
        opts.buildGraph = true;
        break;
      case "--lint-html":
        opts.lintHtmlOut = argv[++i];
        opts.lint = true;
        break;
      case "--project-root":
        opts.projectRoot = argv[++i];
        break;
      case "--ignore-dead": {
        const pat = argv[++i];
        if (pat) (opts.ignoreDead ??= []).push(pat);
        break;
      }
      case "--dead":
        opts.printDead = true;
        opts.buildGraph = true;
        break;
      case "--dead-only":
        opts.printDead = true;
        opts.deadOnly = true;
        opts.buildGraph = true;
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
  process.stdout.write(`convex-doctor

Static analyzer for Convex: ReturnsValidationError drift + best-practice lints.

Usage:
  convex-doctor [options]

Options:
  --convex-dir <path>      Path to convex/ directory. Default: convex
  --schema <path>          Path to schema.ts. Default: <convex-dir>/schema.ts
  --include-unanalyzed     Print INFO entries for handlers that couldn't be statically analyzed
  --json                   Emit JSON instead of text
  --strict                 Exit nonzero if any warnings are present
  --no-lint                Skip the best-practice rules; check returns-validator
                           drift only. (Lint rules run by default: await-in-loop,
                           .filter-in-query, unbounded .collect, sequential
                           ctx.runMutation, nondeterministic query, missing arg
                           validator, legacy function syntax, public scheduling,
                           wrong-runtime import.)
  --lint-html <path>       Write a self-contained HTML report of the
                           best-practice findings, each as a before/after pair.
  --html <path>            Also write a self-contained call-graph HTML
  --project-root <path>    Root scanned for callers when --html is set.
                           Default: parent of <convex-dir>
  --ignore-dead <pattern>  Glob pattern (\`*\` wildcard) excluding nodes
                           from the dead list. Repeatable.
                           Examples: 'migrations:*', '*:migrate*'
  --dead                   Print the dead-function list to stdout (one
                           id per line, after the regular report).
  --dead-only              Suppress the regular report; print only the
                           dead list (text) or only the dead+ignored
                           arrays (when combined with --json).
  -h, --help               Show this help

Exit codes:
  0  No errors (and no warnings if --strict)
  1  Errors found (or warnings under --strict)
  2  Bad arguments
`);
}

/** Best-effort git metadata for the scanned dir, for project name + GitHub
 *  permalinks in the HTML report. Returns {} when not a git repo / no remote. */
function gitInfo(dir: string): {
  repoRoot?: string;
  commitSha?: string;
  repoUrl?: string;
  projectName?: string;
} {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  };
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return {};
  const commitSha = git(["rev-parse", "HEAD"]);
  const remote = git(["remote", "get-url", "origin"]);
  let repoUrl: string | undefined;
  let projectName: string | undefined;
  if (remote) {
    const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (m) {
      repoUrl = `https://github.com/${m[1]}/${m[2]}`;
      projectName = `${m[1]}/${m[2]}`;
    }
  }
  if (!projectName) projectName = repoRoot.split("/").pop();
  return { repoRoot, commitSha, repoUrl, projectName };
}

const opts = parseArgs(process.argv.slice(2));
const result = run(opts);

if (opts.deadOnly) {
  if (opts.format === "json") {
    const ignored = result.graph
      ? result.graph.nodes.filter((n) => n.ignored).map((n) => n.id)
      : [];
    process.stdout.write(
      JSON.stringify({ dead: result.graph?.dead ?? [], ignored }, null, 2) + "\n",
    );
  } else if (result.graph) {
    for (const id of result.graph.dead) process.stdout.write(id + "\n");
  }
} else {
  if (opts.format === "json") {
    process.stdout.write(reportJson(result) + "\n");
  } else {
    process.stdout.write(
      reportText(result, { convexDir: opts.convexDir, color: process.stdout.isTTY ?? false }),
    );
  }

  if (opts.printDead && result.graph) {
    if (opts.format !== "json") {
      const g = result.graph;
      process.stdout.write(`\nDead functions (${g.dead.length}):\n`);
      for (const id of g.dead) process.stdout.write(`  ${id}\n`);
    }
  }
}

if (opts.lintHtmlOut) {
  const git = gitInfo(opts.convexDir);
  const html = reportLintHtml(result.issues, {
    convexDir: opts.convexDir,
    generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    projectName: git.projectName,
    repoUrl: git.repoUrl,
    commitSha: git.commitSha,
    repoRoot: git.repoRoot,
  });
  writeFileSync(opts.lintHtmlOut, html);
  const n = result.issues.filter((i) => LINT_CODES.has(i.code)).length;
  process.stdout.write(`\nWrote ${opts.lintHtmlOut} — ${n} best-practice finding(s) with before/after.\n`);
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
