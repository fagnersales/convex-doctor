import { describe, test, expect } from "bun:test";
import { run } from "../src/scan.ts";
import { reportJson, reportText } from "../src/report.ts";
import type { RunOptions, RunResult } from "../src/types.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

let _result: RunResult | null = null;
function result(): RunResult {
  if (!_result) {
    const opts: RunOptions = {
      convexDir: `${FIX}suppress/convex`,
      schemaPath: undefined,
      includeUnanalyzed: false,
      format: "text",
      strict: false,
      lint: true,
    };
    _result = run(opts);
  }
  return _result;
}

function visibleFor(fn: string): string[] {
  return result()
    .issues.filter((i) => i.function === fn)
    .map((i) => i.code);
}

function suppressedFor(fn: string): string[] {
  return (result().suppressed ?? []).filter((i) => i.function === fn).map((i) => i.code);
}

describe("convex-doctor: ignore comments", () => {
  test("comment on the line above suppresses the finding", () => {
    expect(visibleFor("suppressedAbove")).toEqual([]);
    expect(suppressedFor("suppressedAbove")).toEqual(["AWAIT_IN_LOOP"]);
  });

  test("trailing comment on the flagged line suppresses the finding", () => {
    expect(visibleFor("suppressedTrailing")).toEqual([]);
    expect(suppressedFor("suppressedTrailing")).toEqual(["AWAIT_IN_LOOP"]);
  });

  test("a directive naming a different code does NOT suppress", () => {
    expect(visibleFor("wrongCode")).toContain("AWAIT_IN_LOOP");
    expect(suppressedFor("wrongCode")).toEqual([]);
  });

  test("comma-separated lowercase codes suppress every named finding on the line", () => {
    expect(visibleFor("multiCode")).toEqual([]);
    const codes = suppressedFor("multiCode").sort();
    expect(codes).toContain("UNBOUNDED_COLLECT");
    expect(codes).toContain("FILTER_IN_QUERY");
  });

  test("undirected sites stay flagged, summary counts only visible issues", () => {
    expect(visibleFor("notSuppressed")).toContain("AWAIT_IN_LOOP");
    const summary = result().summary!;
    const visibleTotal = summary.errors + summary.warns + summary.infos;
    expect(visibleTotal).toBe(result().issues.length);
  });

  test("JSON report carries compact suppressed entries; text report tallies them", () => {
    const json = JSON.parse(reportJson(result()));
    expect(Array.isArray(json.suppressed)).toBe(true);
    expect(json.suppressed.length).toBe(result().suppressed!.length);
    for (const entry of json.suppressed) {
      expect(Object.keys(entry).sort()).toEqual(["code", "filePath", "function", "line"]);
    }
    const text = reportText(result());
    expect(text).toContain("suppressed by `convex-doctor: ignore` comments");
  });
});
