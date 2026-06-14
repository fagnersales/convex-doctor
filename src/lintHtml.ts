/**
 * Self-contained HTML report for the best-practice lints — renders each finding
 * as a BEFORE (real source excerpt) / AFTER (recommended fix) pair so the fix is
 * visible at a glance. No external assets; everything is inlined.
 */
import { readFileSync, realpathSync } from "node:fs";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import type { Issue, IssueCode } from "./types.ts";
import { CATEGORY_LABEL, CATEGORY_ORDER, RULE_META, type DiagCategory } from "./rules.ts";

export const LINT_CODES = new Set<IssueCode>([
  "AWAIT_IN_LOOP",
  "FILTER_IN_QUERY",
  "UNBOUNDED_COLLECT",
  "SEQUENTIAL_CTX_RUN",
  "NONDETERMINISTIC_QUERY",
  "MISSING_ARG_VALIDATOR",
  "OLD_FUNCTION_SYNTAX",
  "SCHEDULE_PUBLIC_FN",
  "WRONG_RUNTIME_IMPORT",
  "FLOATING_CTX_PROMISE",
  "FETCH_IN_QUERY",
  "DB_IN_ACTION",
  "QUERY_IN_NODE_FILE",
  "NODE_BUILTIN_WITHOUT_USE_NODE",
  "MISPLACED_USE_NODE",
  "CRON_PUBLIC_FN",
  "DUPLICATE_CRON_ID",
  "CTX_RUN_IN_QUERY_OR_MUTATION",
  "REDUNDANT_INDEX",
  "SCHEMA_VALIDATION_DISABLED",
]);

export interface LintHtmlOptions {
  convexDir?: string;
  generatedAt?: string;
  /** Display name (e.g. `owner/repo` or the repo folder name). */
  projectName?: string;
  /** GitHub project URL base (e.g. `https://github.com/owner/repo`). */
  repoUrl?: string;
  /** Commit SHA the scan ran against — used for stable blob permalinks. */
  commitSha?: string;
  /** Absolute repo root, to compute file paths relative to the repo. */
  repoRoot?: string;
}

export function reportLintHtml(issues: Issue[], opts: LintHtmlOptions = {}): string {
  const lint = issues.filter((i) => LINT_CODES.has(i.code));
  const counts = tally(lint);

  // Build the cards, assigning each a stable id and remembering the first id per
  // rule so the summary chips can jump straight to a rule's first finding.
  let idx = 0;
  const firstIdByCode = new Map<IssueCode, string>();
  const sections: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const catIssues = lint.filter((i) => (i.category ?? RULE_META[i.code].category) === cat);
    if (catIssues.length === 0) continue;
    catIssues.sort(sortFn);
    const cards = catIssues
      .map((i) => {
        const id = `f${idx++}`;
        if (!firstIdByCode.has(i.code)) firstIdByCode.set(i.code, id);
        return renderCard(i, opts, id);
      })
      .join("\n");
    sections.push(`
      <section class="cat">
        <h2><span class="cat-dot ${cat}"></span>${esc(CATEGORY_LABEL[cat])} <span class="cat-n">${catIssues.length}</span></h2>
        ${cards}
      </section>`);
  }

  const summary = renderSummary(lint, firstIdByCode);

  const empty =
    lint.length === 0
      ? `<div class="empty">No best-practice issues found. This codebase is clean. ✓</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Convex best-practice report</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand">convex-doctor <span class="sub">best-practice report</span></div>
  <div class="legend">
    <span class="pill err">${counts.error} errors</span>
    <span class="pill warn">${counts.warn} warnings</span>
    <span class="pill info">${counts.info} info</span>
    ${opts.generatedAt ? `<span class="gen">${esc(opts.generatedAt)}</span>` : ""}
  </div>
</header>
<main>
  ${renderProjectBar(opts)}
  <p class="intro">Each card shows the offending code (<b>before</b>) next to the recommended fix (<b>after</b>). Findings fire on any Convex code, independent of <code>returns</code> validators.</p>
  ${summary}
  ${empty}
  ${sections.join("\n")}
</main>
</body>
</html>`;
}

// ── Summary (per-rule overview) ──────────────────────────────────────────────

function renderSummary(issues: Issue[], firstIdByCode: Map<IssueCode, string>): string {
  if (issues.length === 0) return "";
  const by = new Map<IssueCode, { n: number; error: number; warn: number; info: number }>();
  for (const i of issues) {
    const c = by.get(i.code) ?? { n: 0, error: 0, warn: 0, info: 0 };
    c.n++;
    c[i.severity]++;
    by.set(i.code, c);
  }
  const entries = [...by.entries()].sort((a, b) => {
    const sa = a[1].error ? 0 : a[1].warn ? 1 : 2;
    const sb = b[1].error ? 0 : b[1].warn ? 1 : 2;
    return sa - sb || b[1].n - a[1].n;
  });

  const chips = entries
    .map(([code, c]) => {
      const sev = c.error ? "error" : c.warn ? "warn" : "info";
      const id = firstIdByCode.get(code);
      const split = c.warn && c.info ? ` (${c.warn}w · ${c.info}i)` : "";
      return `<a class="chip ${sev}" href="${id ? `#${id}` : "#"}" title="${esc(RULE_META[code].title)}${esc(split)}">
        <span class="chip-code">${esc(code)}</span><span class="chip-n">${c.n}</span></a>`;
    })
    .join("\n");

  const top = entries[0];
  const rules = entries.length;
  const headline =
    `<b>${issues.length}</b> finding${issues.length === 1 ? "" : "s"} across ${rules} rule${rules === 1 ? "" : "s"}` +
    (top ? ` — most common <b>${esc(top[0])}</b> (${top[1].n})` : "") +
    `. Jump to any rule:`;

  return `<section class="summary">
    <h2>Summary</h2>
    <p class="sum-head">${headline}</p>
    <div class="chips">${chips}</div>
  </section>`;
}

// ── Project bar (name + commit) ──────────────────────────────────────────────

function renderProjectBar(opts: LintHtmlOptions): string {
  if (!opts.projectName && !opts.commitSha) return "";
  const name = opts.projectName
    ? opts.repoUrl
      ? `<a class="proj-name" href="${esc(opts.repoUrl)}" target="_blank" rel="noreferrer">${esc(opts.projectName)}</a>`
      : `<span class="proj-name">${esc(opts.projectName)}</span>`
    : "";
  let sha = "";
  if (opts.commitSha) {
    const short = opts.commitSha.slice(0, 7);
    sha = opts.repoUrl
      ? `<a class="sha" href="${esc(opts.repoUrl)}/commit/${esc(opts.commitSha)}" target="_blank" rel="noreferrer">commit ${esc(short)} ↗</a>`
      : `<span class="sha">commit ${esc(short)}</span>`;
  }
  return `<div class="projbar">${name}${sha}</div>`;
}

// ── Card ─────────────────────────────────────────────────────────────────────

function renderCard(issue: Issue, opts: LintHtmlOptions, id?: string): string {
  const meta = RULE_META[issue.code];
  const sev = issue.severity;
  const line = issue.pointerLine ?? issue.line;
  const loc = `${rel(issue.filePath, opts.convexDir)}:${line}`;
  const before = beforeSnippet(issue);
  const after = afterSnippet(issue, before);
  const url = blobUrl(opts, issue.filePath, line);
  const locHtml = url
    ? `<a class="loc" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(loc)} · ${esc(issue.function)} ↗</a>`
    : `<span class="loc">${esc(loc)} · ${esc(issue.function)}</span>`;

  return `
  <article class="card ${sev}"${id ? ` id="${id}"` : ""}>
    <div class="card-head">
      <span class="sev ${sev}">${sevIcon(sev)}</span>
      <span class="code">${esc(issue.code)}</span>
      <span class="title">${esc(meta.title)}</span>
      ${locHtml}
    </div>
    <div class="msg">${esc(issue.message)}</div>
    ${issue.why ? `<div class="why"><span>why</span> ${esc(issue.why)}</div>` : ""}
    <div class="diff">
      <div class="pane before">
        <div class="pane-label">before</div>
        <pre><code>${esc(before)}</code></pre>
      </div>
      <div class="pane after">
        <div class="pane-label">after — ${esc(shortFix(issue))}</div>
        <pre><code>${esc(after)}</code></pre>
      </div>
    </div>
    <a class="docs" href="${esc(issue.docUrl ?? meta.docUrl)}" target="_blank" rel="noreferrer">Convex docs →</a>
  </article>`;
}

// ── Before: real source excerpt ──────────────────────────────────────────────

const fileCache = new Map<string, string[] | null>();

function sourceLines(filePath: string): string[] | null {
  let s = fileCache.get(filePath);
  if (s === undefined) {
    try {
      s = readFileSync(filePath, "utf8").split("\n");
    } catch {
      s = null;
    }
    fileCache.set(filePath, s);
  }
  return s;
}

/** The complete offending source. Prefers the exact AST excerpt captured at lint
 *  time (never sliced mid-expression); falls back to a source-line window. */
function beforeSnippet(issue: Issue): string {
  if (issue.fixCode?.before) return issue.fixCode.before;
  const src = sourceLines(issue.filePath);
  const line = issue.pointerLine ?? issue.line;
  if (!src || line < 1) return "(source unavailable)";
  // Registration-level rules read best with a few lines of head; body rules with
  // a couple lines of context around the hit.
  const head = issue.code === "MISSING_ARG_VALIDATOR" || issue.code === "OLD_FUNCTION_SYNTAX";
  const from = Math.max(1, line - (head ? 0 : 1));
  const to = Math.min(src.length, line + (head ? 3 : 2));
  return dedent(src.slice(from - 1, to)).join("\n");
}

// ── After: the recommended fix ───────────────────────────────────────────────

/** Prefer an instance-specific transform of the real `before`; fall back to the
 *  canonical recommended pattern for the rule. */
function afterSnippet(issue: Issue, before: string): string {
  switch (issue.code) {
    case "SCHEDULE_PUBLIC_FN": {
      // The fix is at the target's DEFINITION, not a call-site rename — swapping
      // api.→internal. only compiles if the function is actually an internal*.
      // Be honest about that rather than showing a fake one-line patch.
      const swapped = before.replace(/\bapi\./g, "internal.");
      return `${swapped}
// Only valid once the target is defined as an internal* function:
//   the real change is query -> internalQuery (etc.) on its DEFINITION.
// If a client also calls it, leave it public and move the shared logic
// into a plain helper function instead (no ctx.runQuery needed).`;
    }
    case "UNBOUNDED_COLLECT":
      if (before.includes(".collect()")) {
        return (
          before.replace(".collect()", ".take(100)") +
          `\n// or .paginate(opts) for an unbounded list, or add .withIndex(...) to narrow`
        );
      }
      return CANONICAL.UNBOUNDED_COLLECT;
    case "AWAIT_IN_LOOP":
      return awaitLoopAfter(before);
    case "FILTER_IN_QUERY":
      return filterAfter(before);
    case "NONDETERMINISTIC_QUERY":
      return CANONICAL.NONDETERMINISTIC_QUERY;
    case "SEQUENTIAL_CTX_RUN":
      return CANONICAL.SEQUENTIAL_CTX_RUN;
    case "MISSING_ARG_VALIDATOR":
      return addArgs(before);
    case "OLD_FUNCTION_SYNTAX":
      return CANONICAL.OLD_FUNCTION_SYNTAX;
    case "WRONG_RUNTIME_IMPORT":
      return CANONICAL.WRONG_RUNTIME_IMPORT;
    default:
      return issue.fix ?? RULE_META[issue.code].fixHint;
  }
}

/** Rewrite a `for-of { await ... }` loop into a parallel Promise.all batch using
 *  the real iterable / item / call from the source. Falls back to canonical. */
function awaitLoopAfter(before: string): string {
  const forOf = before.match(/for\s*\(\s*const\s+(\w+)\s+of\s+([^)]+?)\s*\)\s*\{/);
  const aw = before.match(/await\s+([^\n;]+?)\s*;/);
  if (!forOf || !aw) return CANONICAL.AWAIT_IN_LOOP;
  const item = forOf[1]!;
  const iterable = forOf[2]!.trim();
  const call = aw[1]!.trim();
  const isWrite = /\.(patch|insert|replace|delete)\(|runMutation\(/.test(call);
  const caveat = isWrite ? `\n// only safe if each write targets a different document` : "";
  return `// Run the calls in parallel — one batch instead of one round-trip per item:
const results = await Promise.all(
  ${iterable}.map((${item}) => ${call}),
);${caveat}`;
}

/** Rewrite `.filter(q => q.eq(q.field("f"), val))` into `.withIndex(...)` using
 *  the real field/value from the source. Falls back to canonical. */
function filterAfter(before: string): string {
  const m = before.match(
    /\.filter\(\s*\(?\w+\)?\s*=>\s*\w+\.eq\(\s*\w+\.field\(\s*"([^"]+)"\s*\)\s*,\s*([^)]+?)\)\s*\)/,
  );
  if (!m) return CANONICAL.FILTER_IN_QUERY;
  const field = m[1]!;
  const val = m[2]!.trim();
  return (
    before.replace(m[0], `.withIndex("by_${field}", (q) => q.eq("${field}", ${val}))`) +
    `\n// add .index("by_${field}", ["${field}"]) to this table in schema.ts`
  );
}

/** Insert an `args: {}` validator right after the registration's opening brace. */
function addArgs(before: string): string {
  const m = before.match(/\b(query|mutation|action|internalQuery|internalMutation|internalAction)\(\{/);
  if (m) {
    const idx = before.indexOf(m[0]) + m[0].length;
    const indent = "\n  args: {}, // declare + validate the arguments";
    return before.slice(0, idx) + indent + before.slice(idx);
  }
  return `args: {}, // add an args validator to the function config`;
}

const CANONICAL = {
  AWAIT_IN_LOOP: `// Issue the calls together — one parallel batch, not N round-trips:
const results = await Promise.all(
  items.map((item) => ctx.db.get(item._id)),
);
// (for writes, only batch when they touch different documents)`,
  FILTER_IN_QUERY: `// Add an index in schema.ts:   .index("by_field", ["field"])
// then narrow at the database instead of scanning every row:
await ctx.db
  .query("table")
  .withIndex("by_field", (q) => q.eq("field", value))
  .collect();`,
  UNBOUNDED_COLLECT: `await ctx.db
  .query("table")
  .withIndex("by_field", (q) => q.eq("field", value))
  .take(100); // or .paginate(opts) for an unbounded list`,
  NONDETERMINISTIC_QUERY: `// Compute time in a mutation/action and pass it in as an argument:
export const trending = query({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const since = args.now - 1000;
    // ...
  },
});`,
  SEQUENTIAL_CTX_RUN: `// One mutation = one transaction (atomic), one round-trip:
await ctx.runMutation(internal.module.doBoth, { /* ... */ });`,
  OLD_FUNCTION_SYNTAX: `export const fn = query({
  args: {},                       // now you can validate input
  handler: async (ctx) => {
    // ...
  },
});`,
  WRONG_RUNTIME_IMPORT: `// Either move the shared code into a runtime-neutral module,
// or mark THIS file for the Node runtime if it truly needs it:
"use node";`,
};

function shortFix(issue: Issue): string {
  const map: Partial<Record<IssueCode, string>> = {
    AWAIT_IN_LOOP: "batch with Promise.all",
    FILTER_IN_QUERY: "use an index",
    UNBOUNDED_COLLECT: "bound the read",
    SEQUENTIAL_CTX_RUN: "one transaction",
    NONDETERMINISTIC_QUERY: "pass time as an arg",
    MISSING_ARG_VALIDATOR: "add args validator",
    OLD_FUNCTION_SYNTAX: "object syntax",
    SCHEDULE_PUBLIC_FN: "make the target internal",
    WRONG_RUNTIME_IMPORT: "fix the runtime",
    FLOATING_CTX_PROMISE: "add await",
    FETCH_IN_QUERY: "move to an action",
    DB_IN_ACTION: "use ctx.runQuery / runMutation",
    QUERY_IN_NODE_FILE: "move out of the node file",
    NODE_BUILTIN_WITHOUT_USE_NODE: "add use node",
    MISPLACED_USE_NODE: "move use node to the top",
    CRON_PUBLIC_FN: "use internal.*",
    DUPLICATE_CRON_ID: "rename the cron",
    CTX_RUN_IN_QUERY_OR_MUTATION: "use a plain helper",
    REDUNDANT_INDEX: "drop the prefix index",
    SCHEMA_VALIDATION_DISABLED: "re-enable validation",
  };
  return map[issue.code] ?? "recommended fix";
}

// ── helpers ──────────────────────────────────────────────────────────────────

function tally(issues: Issue[]): { error: number; warn: number; info: number } {
  const c = { error: 0, warn: 0, info: 0 };
  for (const i of issues) c[i.severity]++;
  return c;
}

function sortFn(a: Issue, b: Issue): number {
  const rank = { error: 0, warn: 1, info: 2 } as const;
  const s = rank[a.severity] - rank[b.severity];
  if (s !== 0) return s;
  const f = a.filePath.localeCompare(b.filePath);
  if (f !== 0) return f;
  return (a.pointerLine ?? a.line) - (b.pointerLine ?? b.line);
}

function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^\s*/)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

function sevIcon(sev: Issue["severity"]): string {
  return sev === "error" ? "✖" : sev === "warn" ? "⚠" : "ℹ";
}

/** GitHub blob permalink for a finding, pinned to the scanned commit. */
function blobUrl(opts: LintHtmlOptions, filePath: string, line: number): string | null {
  if (!opts.repoUrl || !opts.commitSha || !opts.repoRoot) return null;
  // Canonicalize both ends: git reports the real path (e.g. /private/tmp on
  // macOS) while ts-morph keeps the symlinked one (/tmp), which would otherwise
  // make the relative path escape with "..".
  const root = canon(pathResolve(opts.repoRoot));
  const relPath = pathRelative(root, canon(filePath));
  if (relPath.startsWith("..")) return null;
  return `${opts.repoUrl}/blob/${opts.commitSha}/${relPath}#L${line}`;
}

function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function rel(filePath: string, convexDir?: string): string {
  if (convexDir) {
    const abs = pathResolve(convexDir);
    const r = pathRelative(abs, filePath);
    if (!r.startsWith("..")) return r;
    const root = pathResolve(abs, "..");
    const rr = pathRelative(root, filePath);
    if (!rr.startsWith("..")) return rr;
  }
  return filePath;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root {
  --bg: #0d1117; --panel: #161b22; --line: #30363d; --fg: #e6edf3; --dim: #8b949e;
  --red: #f85149; --yel: #d29922; --blu: #58a6ff; --grn: #3fb950;
  --before: #2d1416; --after: #102a17;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center;
  justify-content: space-between; padding: 14px 28px; background: rgba(13,17,23,.92);
  border-bottom: 1px solid var(--line); backdrop-filter: blur(6px); }
.brand { font-weight: 700; font-size: 16px; }
.brand .sub { color: var(--dim); font-weight: 400; font-size: 13px; margin-left: 8px; }
.legend { display: flex; gap: 8px; align-items: center; }
.pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  border: 1px solid var(--line); }
.pill.err { color: var(--red); } .pill.warn { color: var(--yel); } .pill.info { color: var(--blu); }
.gen { color: var(--dim); font-size: 12px; margin-left: 6px; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 28px 80px; }
.projbar { display: flex; align-items: center; gap: 14px; margin: 6px 0 14px; flex-wrap: wrap; }
.proj-name { font-size: 18px; font-weight: 700; color: var(--fg); text-decoration: none; }
a.proj-name:hover { color: var(--blu); }
.sha { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; text-decoration: none; }
a.sha:hover { color: var(--blu); border-color: var(--blu); }
.intro { color: var(--dim); margin: 4px 0 22px; }
.intro code { background: var(--panel); padding: 1px 6px; border-radius: 4px; }
.summary { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 16px 18px; margin: 0 0 30px; }
.summary h2 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
.sum-head { margin: 0 0 14px; color: var(--fg); }
.sum-head b { color: var(--fg); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
  border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px 5px 10px; background: var(--bg);
  transition: border-color .12s, transform .12s; }
.chip:hover { transform: translateY(-1px); }
.chip-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; color: var(--fg); }
.chip-n { font-size: 12px; font-weight: 700; border-radius: 6px; padding: 0 7px; }
.chip.error { border-left: 3px solid var(--red); } .chip.error:hover { border-color: var(--red); }
.chip.error .chip-n { background: rgba(248,81,73,.16); color: var(--red); }
.chip.warn { border-left: 3px solid var(--yel); } .chip.warn:hover { border-color: var(--yel); }
.chip.warn .chip-n { background: rgba(210,153,34,.16); color: var(--yel); }
.chip.info { border-left: 3px solid var(--blu); } .chip.info:hover { border-color: var(--blu); }
.chip.info .chip-n { background: rgba(88,166,255,.16); color: var(--blu); }
.empty { padding: 60px; text-align: center; color: var(--grn); font-size: 18px; }
.cat { margin-bottom: 38px; }
.cat h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim);
  border-bottom: 1px solid var(--line); padding-bottom: 8px; display: flex; align-items: center; gap: 10px; }
.cat-n { background: var(--panel); border: 1px solid var(--line); border-radius: 999px;
  padding: 0 9px; font-size: 12px; color: var(--fg); }
.cat-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--blu); }
.cat-dot.performance { background: var(--yel); } .cat-dot.reactivity { background: var(--blu); }
.cat-dot.best-practice { background: var(--grn); } .cat-dot.runtime { background: var(--red); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 16px 18px; margin: 16px 0; scroll-margin-top: 72px; }
.card.warn { border-left: 3px solid var(--yel); } .card.info { border-left: 3px solid var(--blu); }
.card.error { border-left: 3px solid var(--red); }
.card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sev { font-weight: 700; } .sev.warn { color: var(--yel); } .sev.info { color: var(--blu); } .sev.error { color: var(--red); }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; font-size: 13px; }
.title { font-weight: 600; }
.loc { margin-left: auto; color: var(--dim); font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-decoration: none; }
a.loc:hover { color: var(--blu); }
.msg { margin: 10px 0 6px; }
.why { color: var(--dim); font-size: 13px; margin-bottom: 12px; }
.why span { color: var(--blu); font-weight: 600; text-transform: uppercase; font-size: 11px; margin-right: 4px; }
.diff { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 760px) { .diff { grid-template-columns: 1fr; } }
.pane { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.pane.before { background: var(--before); }
.pane.after { background: var(--after); }
.pane-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700;
  padding: 6px 12px; border-bottom: 1px solid var(--line); }
.pane.before .pane-label { color: var(--red); }
.pane.after .pane-label { color: var(--grn); }
pre { margin: 0; padding: 12px; overflow-x: auto; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; white-space: pre; }
.docs { display: inline-block; margin-top: 12px; color: var(--blu); text-decoration: none; font-size: 13px; }
.docs:hover { text-decoration: underline; }
`;
