import { readFileSync } from "node:fs";
import { resolve as pathResolve, relative as pathRelative } from "node:path";
import type {
  FixCode,
  Issue,
  IssueCode,
  IssueSeverity,
  RunResult,
  RunSummary,
  Timings,
} from "./types.ts";
import {
  AUTOFIX,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  RULE_META,
  type AutofixCapability,
  type DiagCategory,
} from "./rules.ts";

export interface ReportOptions {
  /** convex dir, used to render project-relative paths + the re-run command. */
  convexDir?: string;
  /** Colorize output (default: off — callers pass process.stdout.isTTY). */
  color?: boolean;
}

// ── ANSI helpers (no-ops unless color is on) ──────────────────────────────
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
};

function painter(color: boolean) {
  return (code: keyof typeof ANSI, text: string) =>
    color ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

const SEV_META = {
  error: { icon: "✖", color: "red" as const, label: "error" },
  warn: { icon: "⚠", color: "yellow" as const, label: "warning" },
  info: { icon: "ℹ", color: "blue" as const, label: "info" },
};

const SEV_RANK = { error: 0, warn: 1, info: 2 };

// ── Summary ───────────────────────────────────────────────────────────────

/** Compute the tally + headline once, after matching. */
export function summarize(issues: Issue[], scannedFunctions: number): RunSummary {
  let errors = 0;
  let warns = 0;
  let infos = 0;
  const byCategory = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, 0]),
  ) as Record<DiagCategory, number>;
  const byCode: Partial<Record<IssueCode, number>> = {};
  const affected = new Set<string>();

  for (const i of issues) {
    if (i.severity === "error") errors++;
    else if (i.severity === "warn") warns++;
    else infos++;
    const cat = i.category ?? RULE_META[i.code].category;
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    byCode[i.code] = (byCode[i.code] ?? 0) + 1;
    if (i.severity === "error") affected.add(`${i.filePath}::${i.function}`);
  }

  // Most frequent *error-bearing* code. The "Most common" clause is attached
  // to the runtime-error headline, so a coverage-only code (UNANALYZED) must
  // never win it — that would conflate an info gap with a runtime throw.
  const errorByCode: Partial<Record<IssueCode, number>> = {};
  for (const i of issues) {
    if (i.severity === "error") errorByCode[i.code] = (errorByCode[i.code] ?? 0) + 1;
  }
  let topCode: IssueCode | null = null;
  let topN = 0;
  for (const [code, n] of Object.entries(errorByCode) as [IssueCode, number][]) {
    if (n > topN) {
      topN = n;
      topCode = code;
    }
  }

  const affectedFns = affected.size;
  const fnWord = scannedFunctions === 1 ? "function" : "functions";
  const headline =
    affectedFns === 0
      ? infos + warns === 0
        ? `All ${scannedFunctions} ${fnWord} match their returns validator.`
        : `No runtime errors found across ${scannedFunctions} ${fnWord} (${warns} warning(s), ${infos} info).`
      : `${affectedFns} of ${scannedFunctions} function(s) return data that won't match their \`returns\` validator — Convex throws ReturnsValidationError at runtime.` +
        (topCode ? ` Most common: ${topCode} (${topN}).` : "");

  return { errors, warns, infos, scannedFunctions, affectedFns, topCode, byCategory, byCode, headline };
}

// ── Text report ─────────────────────────────────────────────────────────────

export function reportText(result: RunResult, opts: ReportOptions = {}): string {
  const color = opts.color ?? false;
  const paint = painter(color);
  const { issues, scannedFunctions, timings } = result;
  const summary = result.summary ?? summarize(issues, scannedFunctions);

  if (issues.length === 0) {
    return (
      `${paint("green", "✓")} ${paint("bold", summary.headline)}\n` +
      `${paint("gray", timingLine(timings, scannedFunctions))}\n`
    );
  }

  const lines: string[] = [];

  // Header: headline + tally.
  lines.push("");
  lines.push(`  ${paint("bold", "convex-doctor")}`);
  lines.push("");
  for (const w of wrap(summary.headline, 76)) lines.push(`  ${w}`);
  lines.push("");
  lines.push(`  ${tallyLine(summary, paint)}      ${paint("gray", `scanned ${scannedFunctions} function(s) in ${formatMs(timings.totalMs)}`)}`);

  const fileCache = new Map<string, string[] | null>();

  // Group by category (ordered), then by file.
  const byCategory = groupByCategory(issues);
  for (const cat of CATEGORY_ORDER) {
    const catIssues = byCategory.get(cat);
    if (!catIssues || catIssues.length === 0) continue;
    lines.push("");
    lines.push(paint("gray", `${"─".repeat(78)}`));
    lines.push(`  ${paint("bold", CATEGORY_LABEL[cat].toUpperCase())}  ${paint("gray", `(${catIssues.length})`)}`);
    lines.push(paint("gray", `${"─".repeat(78)}`));

    sortIssues(catIssues);
    for (const issue of catIssues) {
      lines.push("");
      renderIssue(lines, issue, opts, paint, fileCache);
    }
  }

  // Footer: next steps.
  lines.push("");
  lines.push(paint("gray", `${"─".repeat(78)}`));
  lines.push(...nextSteps(summary, opts, paint));
  lines.push(`  ${paint("gray", timingLine(timings, scannedFunctions))}`);
  lines.push("");

  return lines.join("\n");
}

function renderIssue(
  lines: string[],
  issue: Issue,
  opts: ReportOptions,
  paint: ReturnType<typeof painter>,
  fileCache: Map<string, string[] | null>,
): void {
  const sev = SEV_META[issue.severity];
  const meta = RULE_META[issue.code];
  const title = meta.title;

  // Headline row: icon CODE · title ......... severity
  const head = `${paint(sev.color, sev.icon)} ${paint("bold", issue.code)} ${paint("gray", "·")} ${title}`;
  lines.push(`  ${head}   ${paint(sev.color, sev.label)}`);

  // Location row.
  const loc = `${rel(issue.filePath, opts.convexDir)}:${issue.pointerLine ?? issue.line}`;
  const where =
    `${paint("cyan", loc)} ${paint("gray", "·")} ${issue.function}` +
    (issue.table ? ` ${paint("gray", `· table "${issue.table}"`)}` : "");
  lines.push(`     ${where}`);
  lines.push("");

  // Message.
  for (const w of wrap(issue.message, 72)) lines.push(`     ${w}`);

  // Why.
  if (issue.why) {
    lines.push("");
    const wrapped = wrap(issue.why, 66);
    wrapped.forEach((w, idx) => {
      lines.push(`     ${idx === 0 ? paint("gray", "why ") : "    "} ${w}`);
    });
  }

  // Fix (structured before/after/add/remove > plain hint).
  const fixLines = renderFix(issue, paint);
  if (fixLines.length > 0) {
    lines.push("");
    fixLines.forEach((w, idx) => {
      lines.push(`     ${idx === 0 ? paint("green", "fix ") : "    "} ${w}`);
    });
  }

  // Source excerpt with caret.
  const excerpt = renderExcerpt(issue, paint, fileCache);
  if (excerpt.length > 0) {
    lines.push("");
    lines.push(...excerpt);
  }

  // Docs.
  if (issue.docUrl) {
    lines.push("");
    lines.push(`     ${paint("gray", "docs")} ${paint("blue", issue.docUrl)}`);
  }
}

function renderFix(issue: Issue, paint: ReturnType<typeof painter>): string[] {
  const fc = issue.fixCode;
  const out: string[] = [];
  if (fc) {
    if (fc.add) out.push(`${paint("gray", "add")}     ${paint("green", oneLine(fc.add))}`);
    if (fc.remove) out.push(`${paint("gray", "remove")}  ${paint("red", oneLine(fc.remove))}`);
    if (fc.before && fc.after) {
      out.push(`${paint("gray", "change")}  ${paint("red", oneLine(fc.before))}`);
      out.push(`${paint("gray", "to")}      ${paint("green", oneLine(fc.after))}`);
    } else if (fc.after && !fc.before) {
      out.push(`${paint("gray", "use")}     ${paint("green", oneLine(fc.after))}`);
    }
  }
  if (out.length === 0 && issue.fix) {
    for (const w of wrap(issue.fix, 66)) out.push(w);
  }
  return out;
}

/** Collapse a possibly multi-line validator fragment to one tidy line so the
 *  fix block stays gutter-aligned. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function renderExcerpt(
  issue: Issue,
  paint: ReturnType<typeof painter>,
  fileCache: Map<string, string[] | null>,
): string[] {
  const pointerLine = issue.pointerLine ?? issue.line;
  if (!pointerLine || pointerLine < 1) return [];
  let src = fileCache.get(issue.filePath);
  if (src === undefined) {
    try {
      src = readFileSync(issue.filePath, "utf8").split("\n");
    } catch {
      src = null;
    }
    fileCache.set(issue.filePath, src);
  }
  if (!src) return [];

  const out: string[] = [];
  const from = Math.max(1, pointerLine - 1);
  const to = Math.min(src.length, pointerLine + 1);
  const gutterW = String(to).length;
  for (let ln = from; ln <= to; ln++) {
    const text = src[ln - 1] ?? "";
    const gutter = String(ln).padStart(gutterW);
    const isHit = ln === pointerLine;
    const bar = paint("gray", "│");
    if (isHit) {
      out.push(`     ${paint("gray", gutter)} ${bar} ${text}`);
      const col = issue.pointerColumn ?? indentOf(text);
      const len = Math.max(1, issue.pointerLength ?? Math.max(1, text.trim().length));
      const caret = " ".repeat(Math.max(0, col)) + "^".repeat(len);
      out.push(`     ${" ".repeat(gutterW)} ${bar} ${paint(SEV_META[issue.severity].color, caret)}`);
    } else {
      out.push(`     ${paint("gray", `${gutter} │ ${text}`)}`);
    }
  }
  return out;
}

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1]!.length : 0;
}

function nextSteps(
  summary: RunSummary,
  opts: ReportOptions,
  paint: ReturnType<typeof painter>,
): string[] {
  const out: string[] = [];
  out.push(`  ${paint("bold", "Next steps")}`);
  if (summary.affectedFns > 0) {
    out.push(
      `  • Fix the ${summary.errors} error(s) above — each is a row that fails \`returns\` validation at runtime.`,
    );
  }
  if (summary.warns > 0) {
    out.push(`  • ${summary.warns} warning(s): likely-but-unproven drift; review and tighten or silence.`);
  }
  const cmd = opts.convexDir
    ? `bunx convex-doctor --convex-dir ${opts.convexDir}`
    : `bunx convex-doctor`;
  out.push(`  • Re-run after editing:  ${paint("cyan", cmd)}`);
  out.push(`  • Gate CI on it:  add \`${cmd}\` to your typecheck step (exit 1 on errors).`);
  out.push("");
  return out;
}

function tallyLine(summary: RunSummary, paint: ReturnType<typeof painter>): string {
  const parts: string[] = [];
  parts.push(paint("red", `✖ ${summary.errors} error${summary.errors === 1 ? "" : "s"}`));
  parts.push(paint("yellow", `⚠ ${summary.warns} warning${summary.warns === 1 ? "" : "s"}`));
  parts.push(paint("blue", `ℹ ${summary.infos} info`));
  return parts.join("   ");
}

function groupByCategory(issues: Issue[]): Map<DiagCategory, Issue[]> {
  const map = new Map<DiagCategory, Issue[]>();
  for (const i of issues) {
    const cat = i.category ?? RULE_META[i.code].category;
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(i);
  }
  return map;
}

function sortIssues(issues: Issue[]): void {
  issues.sort((a, b) => {
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (s !== 0) return s;
    const fa = a.filePath.localeCompare(b.filePath);
    if (fa !== 0) return fa;
    const la = (a.pointerLine ?? a.line) - (b.pointerLine ?? b.line);
    if (la !== 0) return la;
    return a.code.localeCompare(b.code);
  });
}

function rel(filePath: string, convexDir?: string): string {
  if (convexDir) {
    const abs = pathResolve(convexDir);
    const r = pathRelative(abs, filePath);
    if (!r.startsWith("..")) return r;
    // try the project root (parent of convex dir)
    const root = pathResolve(abs, "..");
    const rr = pathRelative(root, filePath);
    if (!rr.startsWith("..")) return rr;
  }
  const cwdRel = pathRelative(process.cwd(), filePath);
  return cwdRel.startsWith("..") ? filePath : cwdRel;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

function timingLine(t: Timings, scanned: number): string {
  const fnPerSec = scanned > 0 && t.totalMs > 0 ? Math.round((scanned / t.totalMs) * 1000) : 0;
  return `Took ${formatMs(t.totalMs)} (${t.filesLoaded} files, ${fnPerSec} fn/s) — load ${formatMs(t.fileLoadMs)} · schema ${formatMs(t.schemaParseMs)} · collect ${formatMs(t.collectMs)} · analyze ${formatMs(t.analyzeMs)}`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

// ── JSON report ───────────────────────────────────────────────────────────────

export function reportJson(result: RunResult): string {
  const summary = result.summary ?? summarize(result.issues, result.scannedFunctions);
  const graph = result.graph
    ? {
        dead: result.graph.dead,
        deadTransitive: result.graph.deadTransitive,
        ignored: result.graph.nodes.filter((n) => n.ignored).map((n) => n.id),
        kept: result.graph.nodes.filter((n) => n.kept).map((n) => n.id),
        nodeCount: result.graph.nodes.length,
        edgeCount: result.graph.edges.length,
        scannedFiles: result.graph.scannedFiles,
      }
    : undefined;
  return JSON.stringify(
    {
      schemaVersion: 1,
      scannedFunctions: result.scannedFunctions,
      summary,
      issues: result.issues,
      timings: result.timings,
      ...(graph ? { graph } : {}),
    },
    null,
    2,
  );
}

// ── Groups (agentic loop unit) ──────────────────────────────────────────────

/**
 * One fixable group = all issues sharing a rule code. The agentic loop locks one
 * group at a time, fixes every site, re-scans, and commits. Ordered by
 * `priority` (errors before warnings before info; within a severity, by the
 * category order) so the agent always takes the top entry.
 */
export interface IssueGroup {
  code: IssueCode;
  title: string;
  category: DiagCategory;
  /** Most severe severity present in the group — drives priority. */
  severity: IssueSeverity;
  count: number;
  errors: number;
  warns: number;
  infos: number;
  /** Distinct files the group touches. */
  files: number;
  /** How much judgment a fix needs: mechanical | guided | manual. */
  autofix: AutofixCapability;
  /** Lower = fix first. */
  priority: number;
  why: string;
  fixHint: string;
  docUrl: string;
}

export function computeGroups(issues: Issue[]): IssueGroup[] {
  const byCode = new Map<IssueCode, Issue[]>();
  for (const i of issues) {
    if (!byCode.has(i.code)) byCode.set(i.code, []);
    byCode.get(i.code)!.push(i);
  }
  const groups: IssueGroup[] = [];
  for (const [code, arr] of byCode) {
    const meta = RULE_META[code];
    let errors = 0;
    let warns = 0;
    let infos = 0;
    const files = new Set<string>();
    for (const i of arr) {
      if (i.severity === "error") errors++;
      else if (i.severity === "warn") warns++;
      else infos++;
      files.add(i.filePath);
    }
    const severity: IssueSeverity = errors > 0 ? "error" : warns > 0 ? "warn" : "info";
    const catIdx = CATEGORY_ORDER.indexOf(meta.category);
    groups.push({
      code,
      title: meta.title,
      category: meta.category,
      severity,
      count: arr.length,
      errors,
      warns,
      infos,
      files: files.size,
      autofix: AUTOFIX[code],
      priority: SEV_RANK[severity] * 100 + (catIdx < 0 ? 99 : catIdx),
      why: meta.why,
      fixHint: meta.fixHint,
      docUrl: meta.docUrl,
    });
  }
  groups.sort(
    (a, b) => a.priority - b.priority || b.count - a.count || a.code.localeCompare(b.code),
  );
  return groups;
}

/** Default cap on sites returned by `--only … --json`, so a 455-issue group
 *  never floods an agent's context. Override with `--limit N` (0 = all). */
export const DEFAULT_ONLY_LIMIT = 20;

/**
 * Trim a fixCode for the work-list: keep the actionable keys (`add`/`remove`/
 * `after`) and a `before` only when it is a short paired diff. A lone multi-line
 * `before` (lint rules capture the whole loop body) is just context the agent
 * already has from the file — dropping it is the bulk of the size win.
 */
function compactFix(fc: FixCode | undefined): FixCode | undefined {
  if (!fc) return undefined;
  const out: FixCode = {};
  if (fc.before && fc.after && fc.before.length <= 160) out.before = fc.before;
  if (fc.after) out.after = fc.after;
  if (fc.add) out.add = fc.add;
  if (fc.remove) out.remove = fc.remove;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function reportGroupsJson(issues: Issue[], scannedFunctions: number): string {
  // Deliberately tiny: just the code, counters, and the autofix tag — enough to
  // pick the top group. The array is priority-ordered, so an agent takes [0].
  // Everything else (why, fix, fixCode, docUrl, source) is one `--only` away.
  const groups = computeGroups(issues).map((g) => ({
    code: g.code,
    severity: g.severity,
    count: g.count,
    files: g.files,
    autofix: g.autofix,
  }));
  return JSON.stringify(
    {
      schemaVersion: 1,
      scannedFunctions,
      remaining: issues.length,
      groupCount: groups.length,
      done: groups.length === 0,
      groups,
    },
    null,
    2,
  );
}

/**
 * Compact work-list for `--only <CODE> --json`. The shared recipe (why / fix /
 * docUrl / autofix) is emitted ONCE under `rule`; each site carries only its
 * own location + concrete `fixCode`. Capped at `limit` (default
 * DEFAULT_ONLY_LIMIT, 0 = all) — fix the batch, re-scan, and the next call
 * returns the next batch (the fixed sites are gone), so context stays bounded.
 */
export function reportOnlyJson(
  issues: Issue[],
  scannedFunctions: number,
  opts: { limit?: number; convexDir?: string } = {},
): string {
  const total = issues.length;
  const cap = opts.limit === undefined ? DEFAULT_ONLY_LIMIT : opts.limit;
  const shown = cap === 0 ? issues : issues.slice(0, cap);

  const codes = new Set(shown.map((i) => i.code));
  const single = codes.size === 1 ? [...codes][0]! : null;

  const sites = shown.map((i) => ({
    file: rel(i.filePath, opts.convexDir),
    line: i.line,
    function: i.function,
    // Only when the selector spans codes (a category) — otherwise it's `rule.code`.
    ...(single ? {} : { code: i.code }),
    message: i.message,
    ...((c) => (c ? { fixCode: c } : {}))(compactFix(i.fixCode)),
    pointer: {
      line: i.pointerLine ?? i.line,
      column: i.pointerColumn ?? null,
      length: i.pointerLength ?? null,
    },
  }));

  const rule = single
    ? {
        code: single,
        autofix: AUTOFIX[single],
        why: RULE_META[single].why,
        fix: RULE_META[single].fixHint,
        docUrl: RULE_META[single].docUrl,
      }
    : null;

  return JSON.stringify(
    {
      schemaVersion: 1,
      scannedFunctions,
      total,
      returned: sites.length,
      remaining: total - sites.length,
      ...(rule ? { rule } : {}),
      sites,
    },
    null,
    2,
  );
}

export function reportGroupsText(
  issues: Issue[],
  scannedFunctions: number,
  opts: ReportOptions = {},
): string {
  const paint = painter(opts.color ?? false);
  const groups = computeGroups(issues);
  if (groups.length === 0) {
    return `${paint("green", "✓")} ${paint("bold", "No groups — nothing to fix.")} (${scannedFunctions} functions scanned)\n`;
  }
  const sevPaint = (s: IssueSeverity, t: string) =>
    paint(s === "error" ? "red" : s === "warn" ? "yellow" : "blue", t);
  const codeW = Math.min(30, Math.max(...groups.map((g) => g.code.length)));
  const cntW = Math.max(...groups.map((g) => String(g.count).length));

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${paint("bold", "convex-doctor")} ${paint("gray", `· ${groups.length} fixable group(s), top first`)}`,
  );
  lines.push("");
  for (const g of groups) {
    const icon = sevPaint(g.severity, SEV_META[g.severity].icon);
    const code = paint("bold", g.code.padEnd(codeW));
    const count = String(g.count).padStart(cntW);
    const files = `${g.files} file${g.files === 1 ? "" : "s"}`;
    lines.push(
      `  ${icon} ${code}  ${count} ${paint("gray", `· ${files} · ${g.autofix}`)}`,
    );
  }
  lines.push("");
  const only = `convex-doctor --only <CODE>` + (opts.convexDir ? ` --convex-dir ${opts.convexDir}` : "");
  lines.push(`  ${paint("gray", "fixes for a group →")} ${paint("cyan", only)}`);
  lines.push(`  ${paint("gray", "the loop       →")} ${paint("cyan", "convex-doctor agent-guide")}`);
  lines.push("");
  return lines.join("\n");
}

export function exitCode(result: RunResult, strict: boolean): number {
  const hasError = result.issues.some((i) => i.severity === "error");
  const hasWarn = result.issues.some((i) => i.severity === "warn");
  if (hasError) return 1;
  if (strict && hasWarn) return 1;
  return 0;
}
