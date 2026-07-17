#!/usr/bin/env bun
import { run } from "./scan.ts";
import {
  reportText,
  reportJson,
  reportGroupsText,
  reportGroupsJson,
  reportOnlyJson,
  summarize,
  exitCode,
} from "./report.ts";
import { CATEGORY_ORDER, RULE_META } from "./rules.ts";
import type { RunOptions } from "./types.ts";

interface CliOptions extends RunOptions {
  printDead?: boolean;
  deadOnly?: boolean;
  /** Restrict the report to a single rule code or category (the agentic group). */
  only?: string;
  /** Cap the issues/sites emitted (0 = all). Keeps an agent's context bounded. */
  limit?: number;
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
      case "--only":
        opts.only = argv[++i];
        break;
      case "--limit": {
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n < 0) {
          console.error("--limit expects a non-negative integer (0 = no limit).");
          process.exit(2);
        }
        opts.limit = n;
        break;
      }
      case "--no-lint":
        opts.lint = false;
        break;
      case "--lint":
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
  convex-doctor groups [options]      List fixable groups (one per rule code)
  convex-doctor agent-guide           Print the agentic fix-loop recipe

Options:
  --convex-dir <path>      Path to convex/ directory. Default: convex
  --schema <path>          Path to schema.ts. Default: <convex-dir>/schema.ts
  --only <code|category>   Restrict the report to one rule code (e.g. AWAIT_IN_LOOP)
                           or category (e.g. performance) — the agentic unit of work.
                           With --json this emits a compact work-list (shared
                           recipe once + per-site fixCode), capped at --limit.
  --limit <n>              Cap emitted issues/sites (0 = all). Default for the
                           --only --json work-list is 50, so a big group can't
                           flood an agent's context — fix the batch, re-scan,
                           the next call returns the next batch.
  --include-unanalyzed     Print INFO entries for handlers that couldn't be statically analyzed
  --json                   Emit JSON instead of text
  --strict                 Exit nonzero if any warnings are present
  --no-lint                Skip the best-practice rules; check returns-validator
                           drift only. (Lint rules run by default: await-in-loop,
                           .filter-in-query, unbounded .collect, sequential
                           ctx.runMutation, nondeterministic query, missing arg
                           validator, legacy function syntax, public scheduling,
                           wrong-runtime import.)
  --project-root <path>    Root scanned for callers (used by --dead).
                           Default: parent of <convex-dir>
  --ignore-dead <pattern>  Glob pattern (\`*\` wildcard) excluding nodes
                           from the dead list. Matching nodes count as live
                           roots, so their callees stay alive too. Repeatable.
                           Examples: 'migrations:*', '*:migrate*'
  --dead                   Print the dead-function list to stdout (one
                           id per line, after the regular report).
                           Dead = unreachable from every external caller;
                           references from other dead functions (or a
                           self-call) don't keep a function alive.
                           String references ("path/file:fn" literals, as
                           used by \`npx convex run\` in scripts) count as
                           callers. To protect a function that is invoked
                           from outside the repo (another service, manual
                           \`npx convex run\`, a webhook), put a comment on
                           the line above its export:
                             // convex-doctor: keep — run manually by ops
  --dead-only              Suppress the regular report; print only the
                           dead list (text) or the dead/transitive/
                           ignored/kept arrays (when combined with --json).
  -h, --help               Show this help

Suppressing a finding:
  When a flagged site is intentional (e.g. a documented sequential loop), put
  an ignore comment on the flagged line or the line directly above it:
    // convex-doctor: ignore AWAIT_IN_LOOP — sequential by design, see comment
  The code is required (no blanket ignore); several codes may be listed,
  comma-separated. Suppressed findings leave the report, groups, and the exit
  code, and are tallied under \`suppressed\` in --json output.

Exit codes:
  0  No errors (and no warnings if --strict)
  1  Errors found (or warnings under --strict)
  2  Bad arguments
`);
}

const AGENT_GUIDE = `convex-doctor — agentic fix loop

Fix one rule code at a time. A "group" is every issue sharing a code; the fix
inside a group is one repeatable recipe. Lock a group, fix every site, verify by
re-scanning, commit, then move to the next. (If the tool isn't installed locally,
replace \`convex-doctor\` below with \`bunx @fagnersales/convex-doctor\`.)

LOOP
  1. List groups, highest priority first:
       convex-doctor groups --json
     If "done": true (groupCount 0) — stop, the codebase is clean.

  2. Lock the TOP group. Read its "code" and "autofix" tag:
       mechanical — the edit is fully determined; apply it directly.
       guided     — deterministic recipe; read the handler/schema context first.
       manual     — architectural/judgment; reason carefully, ask if unsure.

  3. Load a BOUNDED batch of that group's sites (default 50; lower it for big
     groups so you don't flood context):
       convex-doctor --only <CODE> --json --limit 25
     Response: { total, returned, remaining, rule, sites[] }. "rule" carries the
     shared recipe ONCE (why, fix, docUrl, autofix); each site has file, line,
     function, message, fixCode, pointer. Fix every site in the batch.

  4. VERIFY / advance — re-scan the same group:
       convex-doctor --only <CODE> --json --limit 25
     Re-scanning is the cursor: the sites you fixed are gone, so this returns the
     NEXT batch (and surfaces any NEW issue your edits introduced). Repeat 3–4
     until "total" reaches 0 — only then is the group done.

  5. GREEN-GATE — run the project's own checks (whatever it uses), e.g.:
       bun run typecheck     (or tsc --noEmit, or the project lint/test step)

  6. COMMIT this group alone:
       git add -A
       git commit -m "fix(convex): resolve all <CODE> (<n> sites)"

  7. Go to 1.

RULES OF ENGAGEMENT
  • One group per commit — never mix codes in a single commit.
  • Always re-scan (step 4) before committing — it is the proof the fix landed.
  • Prefer fixCode when present; otherwise follow "fix" + the docUrl recipe.
  • Not every site should be "fixed". If the flagged pattern is intentional —
    a comment documents sequential-by-design, an upsert loop relies on
    read-your-writes dedupe, dev-only seed code — do NOT force the recipe.
    Silence it in place, with the reason, on the line above the flagged line:
      // convex-doctor: ignore <CODE> — <why this is intentional>
    Re-scanning then drops the site (it moves to "suppressed"), so the loop
    still converges to 0. Suppress sparingly: the reason must survive review.
  • If a "manual" group needs a design decision you cannot make, skip it, finish
    the rest, and report what you skipped and why.
`;

const argv = process.argv.slice(2);
// A leading non-flag token is a subcommand (`groups` / `agent-guide`).
const subcommand = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;

if (subcommand === "agent-guide") {
  process.stdout.write(AGENT_GUIDE);
  process.exit(0);
}

const opts = parseArgs(argv);

if (subcommand === "groups") {
  const result = run(opts);
  if (opts.format === "json") {
    process.stdout.write(reportGroupsJson(result.issues, result.scannedFunctions) + "\n");
  } else {
    process.stdout.write(
      reportGroupsText(result.issues, result.scannedFunctions, {
        convexDir: opts.convexDir,
        color: process.stdout.isTTY ?? false,
      }),
    );
  }
  process.exit(exitCode(result, opts.strict));
}

const result = run(opts);

// `--only <code|category>` — narrow to a single fixable group. Re-summarize so
// the headline, tally, and exit code reflect just the selected group.
if (opts.only) {
  const sel = opts.only;
  const isCategory = (CATEGORY_ORDER as readonly string[]).includes(sel);
  const isCode = Object.prototype.hasOwnProperty.call(RULE_META, sel);
  if (!isCategory && !isCode) {
    console.error(
      `--only: unknown code or category "${sel}". Run \`convex-doctor groups\` to see the available groups.`,
    );
    process.exit(2);
  }
  const filtered = result.issues.filter((i) =>
    isCategory ? (i.category ?? RULE_META[i.code].category) === sel : i.code === sel,
  );
  result.issues = filtered;
  result.summary = summarize(filtered, result.scannedFunctions);

  // The agentic path: a compact, capped work-list instead of the full report.
  if (opts.format === "json") {
    process.stdout.write(
      reportOnlyJson(filtered, result.scannedFunctions, {
        limit: opts.limit,
        convexDir: opts.convexDir,
      }) + "\n",
    );
    process.exit(exitCode(result, opts.strict));
  }
}

// `--limit` on the text/standard report caps the rendered issues; the summary
// (computed above / by run()) still reflects the true totals.
if (opts.limit && opts.limit > 0) {
  result.issues = result.issues.slice(0, opts.limit);
}

if (opts.deadOnly) {
  if (opts.format === "json") {
    const ignored = result.graph
      ? result.graph.nodes.filter((n) => n.ignored).map((n) => n.id)
      : [];
    const kept = result.graph
      ? result.graph.nodes.filter((n) => n.kept).map((n) => n.id)
      : [];
    process.stdout.write(
      JSON.stringify(
        {
          dead: result.graph?.dead ?? [],
          transitive: result.graph?.deadTransitive ?? [],
          ignored,
          kept,
        },
        null,
        2,
      ) + "\n",
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
      const transitive = new Set(g.deadTransitive);
      process.stdout.write(`\nDead functions (${g.dead.length}):\n`);
      for (const id of g.dead) {
        const note = transitive.has(id) ? "   (referenced only by dead code)" : "";
        process.stdout.write(`  ${id}${note}\n`);
      }
      const kept = g.nodes.filter((n) => n.kept);
      if (kept.length > 0) {
        process.stdout.write(`Kept alive by \`convex-doctor: keep\` comments (${kept.length}):\n`);
        for (const n of kept) process.stdout.write(`  ${n.id}\n`);
      }
    }
  }
}

process.exit(exitCode(result, opts.strict));
