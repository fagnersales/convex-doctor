import { describe, test, expect } from "bun:test";
import { run } from "../src/scan.ts";
import type { Issue, IssueCode, RunOptions } from "../src/types.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

function runLint(fixture: string, lint = true): Issue[] {
  const opts: RunOptions = {
    convexDir: `${FIX}${fixture}/convex`,
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "text",
    strict: false,
    lint,
  };
  return run(opts).issues;
}

/** Lint issues for a given function in the `lint` fixture. */
function lintFor(fn: string): Issue[] {
  return runLint("lint").filter((i) => i.function === fn);
}

function codesFor(fn: string): IssueCode[] {
  return lintFor(fn).map((i) => i.code);
}

// ── Round-2 fixture (lint2) helpers ──────────────────────────────────────────
let _lint2: Issue[] | null = null;
function lint2(): Issue[] {
  if (!_lint2) _lint2 = runLint("lint2");
  return _lint2;
}
function l2For(fn: string): IssueCode[] {
  return lint2()
    .filter((i) => i.function === fn)
    .map((i) => i.code);
}
function l2Code(code: IssueCode): Issue[] {
  return lint2().filter((i) => i.code === code);
}

describe("lint: gating", () => {
  test("lint:false emits no best-practice issues", () => {
    const issues = runLint("lint", false);
    const lintCodes = new Set<IssueCode>([
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
    expect(issues.filter((i) => lintCodes.has(i.code))).toEqual([]);
  });

  test("a clean codebase produces zero lint issues", () => {
    expect(runLint("clean")).toEqual([]);
  });
});

describe("lint: AWAIT_IN_LOOP", () => {
  test("read in a for-of loop → warning", () => {
    const issues = lintFor("wealth").filter((i) => i.code === "AWAIT_IN_LOOP");
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warn");
    expect(issues[0]!.message).toContain("Promise.all");
  });

  test("write in a loop → info with the OCC caveat", () => {
    const issues = lintFor("markAll").filter((i) => i.code === "AWAIT_IN_LOOP");
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("info");
    expect(issues[0]!.message).toContain("conflict");
  });

  test("loop-carried accumulator is NOT flagged", () => {
    expect(codesFor("chained")).not.toContain("AWAIT_IN_LOOP");
  });

  test("Promise.all version is NOT flagged", () => {
    expect(codesFor("wealthClean")).not.toContain("AWAIT_IN_LOOP");
  });
});

describe("lint: query performance", () => {
  test("FILTER_IN_QUERY on a ctx.db.query chain", () => {
    expect(codesFor("byFilter")).toContain("FILTER_IN_QUERY");
  });

  test("UNBOUNDED_COLLECT without an index", () => {
    expect(codesFor("allAgents")).toContain("UNBOUNDED_COLLECT");
  });

  test("collect bounded by .withIndex is NOT flagged", () => {
    expect(codesFor("byOwner")).not.toContain("UNBOUNDED_COLLECT");
  });

  test("JS array .filter on a collected array is NOT flagged", () => {
    expect(codesFor("jsFilter")).not.toContain("FILTER_IN_QUERY");
  });

  test("`.filter()` on a PAGINATED query is NOT flagged (documented exception)", () => {
    expect(codesFor("byFilterPaginated")).not.toContain("FILTER_IN_QUERY");
  });
});

describe("lint: NONDETERMINISTIC_QUERY", () => {
  test("Date.now() and Math.random() in a query are both flagged", () => {
    const issues = lintFor("trending").filter((i) => i.code === "NONDETERMINISTIC_QUERY");
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.severity === "warn")).toBe(true);
  });

  test("Date.now() in a mutation is NOT flagged", () => {
    expect(codesFor("stamp")).not.toContain("NONDETERMINISTIC_QUERY");
  });
});

describe("lint: SEQUENTIAL_CTX_RUN", () => {
  test("two runMutations in an action → info", () => {
    const issues = lintFor("orchestrate").filter((i) => i.code === "SEQUENTIAL_CTX_RUN");
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("info");
  });
});

describe("lint: validators & syntax", () => {
  test("public function missing args → warning", () => {
    const issues = lintFor("noArgs").filter((i) => i.code === "MISSING_ARG_VALIDATOR");
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warn");
  });

  test("internal function missing args → info", () => {
    const issues = lintFor("noArgsInternal").filter((i) => i.code === "MISSING_ARG_VALIDATOR");
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("info");
  });

  test("function WITH args is NOT flagged", () => {
    expect(codesFor("markInternal")).not.toContain("MISSING_ARG_VALIDATOR");
  });

  test("bare-function registration → OLD_FUNCTION_SYNTAX", () => {
    expect(codesFor("legacy")).toContain("OLD_FUNCTION_SYNTAX");
  });
});

describe("lint: SCHEDULE_PUBLIC_FN", () => {
  test("scheduling/calling api.* → warn (both sites)", () => {
    const issues = lintFor("schedulePublic").filter((i) => i.code === "SCHEDULE_PUBLIC_FN");
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.severity === "warn")).toBe(true);
  });

  test("scheduling internal.* is NOT flagged", () => {
    expect(codesFor("scheduleInternal")).not.toContain("SCHEDULE_PUBLIC_FN");
  });
});

describe("lint: WRONG_RUNTIME_IMPORT", () => {
  test("default-runtime file importing a use-node module is flagged", () => {
    const issues = runLint("lint").filter((i) => i.code === "WRONG_RUNTIME_IMPORT");
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("use node");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Round 2 — rules from the full Convex best-practices audit (lint2 fixture)
// ══════════════════════════════════════════════════════════════════════════

describe("lint2: FLOATING_CTX_PROMISE", () => {
  test("un-awaited ctx.db write is flagged (warn)", () => {
    expect(l2For("floatWrite")).toContain("FLOATING_CTX_PROMISE");
    expect(l2Code("FLOATING_CTX_PROMISE").every((i) => i.severity === "warn")).toBe(true);
  });
  test("awaited write is NOT flagged", () => {
    expect(l2For("awaitedWrite")).not.toContain("FLOATING_CTX_PROMISE");
  });
  test("deliberately voided fire-and-forget is NOT flagged", () => {
    expect(l2For("voidedSchedule")).not.toContain("FLOATING_CTX_PROMISE");
  });
});

describe("lint2: FETCH_IN_QUERY", () => {
  test("fetch() in a query is an error", () => {
    const f = lint2().filter((i) => i.code === "FETCH_IN_QUERY" && i.function === "fetchInQuery");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("error");
  });
  test("fetch() in an action is NOT flagged", () => {
    expect(l2For("fetchInAction")).not.toContain("FETCH_IN_QUERY");
  });
});

describe("lint2: DB_IN_ACTION", () => {
  test("ctx.db in an action is an error", () => {
    expect(l2For("dbInAction")).toContain("DB_IN_ACTION");
  });
  test("destructured { db } in an action is an error", () => {
    expect(l2For("dbDestructured")).toContain("DB_IN_ACTION");
  });
  test("all DB_IN_ACTION findings are error severity", () => {
    expect(l2Code("DB_IN_ACTION").every((i) => i.severity === "error")).toBe(true);
  });
});

describe("lint2: CTX_RUN_IN_QUERY_OR_MUTATION", () => {
  test("ctx.runQuery inside a query → info", () => {
    const f = lint2().filter((i) => i.code === "CTX_RUN_IN_QUERY_OR_MUTATION");
    expect(f.length).toBe(1);
    expect(f[0]!.function).toBe("runInQuery");
    expect(f[0]!.severity).toBe("info");
  });
  test("ctx.runQuery(components.*) is NOT flagged (documented exception)", () => {
    expect(l2For("runComponent")).not.toContain("CTX_RUN_IN_QUERY_OR_MUTATION");
  });
});

describe("lint2: runtime rules", () => {
  test("QUERY_IN_NODE_FILE — query in a use-node file is an error", () => {
    const f = lint2().filter((i) => i.code === "QUERY_IN_NODE_FILE");
    expect(f.length).toBe(1);
    expect(f[0]!.function).toBe("inNode");
    expect(f[0]!.severity).toBe("error");
  });
  test("action in a use-node file is NOT flagged", () => {
    expect(l2For("okAction")).not.toContain("QUERY_IN_NODE_FILE");
  });
  test("NODE_BUILTIN_WITHOUT_USE_NODE — node:fs and bare path flagged, type-only skipped", () => {
    const f = l2Code("NODE_BUILTIN_WITHOUT_USE_NODE");
    expect(f.length).toBe(2); // node:fs + path; the `import type` is erased
  });
  test("MISPLACED_USE_NODE — a non-prologue use node directive is flagged", () => {
    const f = l2Code("MISPLACED_USE_NODE");
    expect(f.length).toBe(1);
  });
});

describe("lint2: cron rules", () => {
  test("CRON_PUBLIC_FN — cron scheduling api.* is flagged", () => {
    const f = l2Code("CRON_PUBLIC_FN");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("warn");
  });
  test("DUPLICATE_CRON_ID — repeated identifier is an error, fired once", () => {
    const f = l2Code("DUPLICATE_CRON_ID");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("error");
    expect(f[0]!.message).toContain("cleanup");
  });
});

describe("lint2: schema rules", () => {
  test("REDUNDANT_INDEX — prefix index flagged once; non-prefix pairs ignored", () => {
    const f = l2Code("REDUNDANT_INDEX");
    expect(f.length).toBe(1);
    expect(f[0]!.message).toContain("by_user");
    expect(f[0]!.message).toContain("by_user_and_time");
  });
  test("SCHEMA_VALIDATION_DISABLED — schemaValidation:false flagged (info)", () => {
    const f = l2Code("SCHEMA_VALIDATION_DISABLED");
    expect(f.length).toBe(1);
    expect(f[0]!.severity).toBe("info");
  });
});

describe("lint2: deep-linked docs", () => {
  test("every round-2 finding carries a Convex docs URL", () => {
    const round2 = new Set<IssueCode>([
      "FLOATING_CTX_PROMISE", "FETCH_IN_QUERY", "DB_IN_ACTION", "QUERY_IN_NODE_FILE",
      "NODE_BUILTIN_WITHOUT_USE_NODE", "MISPLACED_USE_NODE", "CRON_PUBLIC_FN",
      "DUPLICATE_CRON_ID", "CTX_RUN_IN_QUERY_OR_MUTATION", "REDUNDANT_INDEX",
      "SCHEMA_VALIDATION_DISABLED",
    ]);
    const found = lint2().filter((i) => round2.has(i.code));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((i) => (i.docUrl ?? "").startsWith("https://docs.convex.dev/"))).toBe(true);
  });
});
