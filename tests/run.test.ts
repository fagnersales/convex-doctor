import { describe, test, expect } from "bun:test";
import { run } from "../src/scan.ts";
import { reportJson, reportText, summarize } from "../src/report.ts";
import { RULE_META } from "../src/rules.ts";
import type { Issue, IssueCode, RunOptions } from "../src/types.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

function runFix(fixture: string) {
  const opts: RunOptions = {
    convexDir: `${FIX}${fixture}/convex`,
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "text",
    strict: false,
  };
  return run(opts);
}

function go(fixture: string): { issues: Issue[]; codes: string[] } {
  const r = runFix(fixture);
  return { issues: r.issues, codes: r.issues.map((i) => i.code) };
}

/** Issues for a single function within a fixture. */
function fnIssues(fixture: string, fn: string): Issue[] {
  return go(fixture).issues.filter((i) => i.function === fn);
}
function fnErrors(fixture: string, fn: string): Issue[] {
  return fnIssues(fixture, fn).filter((i) => i.severity === "error");
}

describe("clean fixture", () => {
  test("emits no issues", () => {
    const { issues } = go("clean");
    expect(issues).toEqual([]);
  });
});

describe("missing field (R1)", () => {
  test("flags a missing REQUIRED schema field as an error", () => {
    const { codes, issues } = go("missing-field");
    expect(codes).toContain("MISSING_FIELD");
    const req = issues.find(
      (i) => i.code === "MISSING_FIELD" && i.message.includes("isActive"),
    )!;
    expect(req).toBeDefined();
    expect(req.severity).toBe("error");
  });
  // A missing OPTIONAL field only throws when that field is actually populated,
  // so it's a warning (potential), not a definite error. (Reclassified after the
  // new-apps corpus run flagged piles of never-populated optionals as errors.)
  test("flags a missing OPTIONAL schema field as a warning", () => {
    const { issues } = go("missing-field");
    const opt = issues.find(
      (i) => i.code === "MISSING_FIELD" && i.message.includes("cachedAvailableBalance"),
    )!;
    expect(opt).toBeDefined();
    expect(opt.severity).toBe("warn");
  });
});

describe("null branch missing (R5)", () => {
  test("flags handler returning .first() without v.null() in validator", () => {
    const { codes } = go("null-branch");
    expect(codes).toContain("NULL_BRANCH_MISSING");
  });
});

describe("cardinality mismatch (R6)", () => {
  test("flags .collect() returning array against single-object validator", () => {
    const { codes } = go("cardinality");
    expect(codes).toContain("CARDINALITY_MISMATCH");
  });
});

describe("spread + drop (R10)", () => {
  test("clean when handler drops a field that validator omits", () => {
    const { issues } = go("spread-drop");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("imported validator (R12)", () => {
  test("follows symbol import to detect drift in another file", () => {
    const { codes, issues } = go("imported-validator");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedBalance");
  });
});

describe("literal returns (R8)", () => {
  test("flags extra fields in literal return", () => {
    const { codes, issues } = go("literal");
    expect(codes).toContain("EXTRA_LITERAL_FIELD");
    const extra = issues.find((i) => i.code === "EXTRA_LITERAL_FIELD")!;
    expect(extra.message).toContain("total");
  });

  test("flags missing required fields in literal return", () => {
    const { issues } = go("literal");
    const missing = issues.filter((i) => i.code === "MISSING_LITERAL_FIELD");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]!.message).toContain("total");
  });
});

describe("optionality mismatch (R3)", () => {
  test("flags schema-optional vs validator-required", () => {
    const { codes, issues } = go("optionality");
    expect(codes).toContain("OPTIONALITY_MISMATCH");
    const opt = issues.find((i) => i.code === "OPTIONALITY_MISMATCH")!;
    expect(opt.message).toContain("description");
  });
});

describe("stale field (R2)", () => {
  test("flags a required validator field not in schema as an error (it throws)", () => {
    const { codes, issues } = go("stale-field");
    expect(codes).toContain("STALE_FIELD");
    const stale = issues.find((i) => i.code === "STALE_FIELD")!;
    expect(stale.message).toContain("legacyField");
    // A required stale field provably throws ReturnsValidationError, so error.
    expect(stale.severity).toBe("error");
  });
});

describe("validator spread (...x.fields)", () => {
  test("clean — spread of plain object inlines fields", () => {
    const { issues } = go("validator-spread");
    const errors = issues.filter(
      (i) => i.severity === "error" && i.function === "getStoreA",
    );
    expect(errors).toEqual([]);
  });

  test("clean — spread of validator .fields inlines fields", () => {
    const { issues } = go("validator-spread");
    const errors = issues.filter(
      (i) => i.severity === "error" && i.function === "getStoreB",
    );
    expect(errors).toEqual([]);
  });

  test("no STALE_FIELD noise from synthetic __spread: keys", () => {
    const { issues } = go("validator-spread");
    const stale = issues.filter((i) => i.code === "STALE_FIELD");
    expect(stale).toEqual([]);
  });
});

describe("conditional ternary — both branches", () => {
  test("flags whenFalse branch's missing field even when whenTrue is clean", () => {
    const { issues } = go("ternary");
    const missing = issues.filter((i) => i.code === "MISSING_LITERAL_FIELD");
    expect(missing.some((i) => i.message.includes("value"))).toBe(true);
  });
});

describe("type mismatch — recursive (R4)", () => {
  test("flags primitive kind mismatch (string vs number)", () => {
    const { issues } = go("type-mismatch");
    const tm = issues.filter((i) => i.code === "TYPE_MISMATCH");
    const names = tm.map((i) => i.message);
    expect(names.some((m) => m.includes("name"))).toBe(true);
  });

  test("flags id table mismatch (id<users> vs id<stores>)", () => {
    const { issues } = go("type-mismatch");
    const tm = issues.filter((i) => i.code === "TYPE_MISMATCH");
    expect(tm.some((i) => i.message.includes("ownerId"))).toBe(true);
  });

  test("flags array element type mismatch", () => {
    const { issues } = go("type-mismatch");
    const tm = issues.filter((i) => i.code === "TYPE_MISMATCH");
    expect(tm.some((i) => i.message.includes("tags"))).toBe(true);
  });

  test("flags union missing-member coverage", () => {
    const { issues } = go("type-mismatch");
    const tm = issues.filter((i) => i.code === "TYPE_MISMATCH");
    expect(tm.some((i) => i.message.includes("status"))).toBe(true);
  });
});

describe("discriminated union (R14)", () => {
  test("matches each literal return to the branch whose literal discriminator agrees", () => {
    const { issues } = go("discriminated-union");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("Promise.all(...)", () => {
  test("traces through Promise.all to flag drift in the map callback", () => {
    const { issues } = go("promise-all");
    const extra = issues.filter((i) => i.code === "EXTRA_LITERAL_FIELD");
    const missing = issues.filter((i) => i.code === "MISSING_LITERAL_FIELD");
    expect(extra.some((i) => i.message.includes("url"))).toBe(true);
    expect(missing.some((i) => i.message.includes("label"))).toBe(true);
  });
});

describe("ctx.runQuery propagation", () => {
  test("flags drift between caller's returns and called fn's returns", () => {
    const { issues } = go("run-query");
    const tm = issues.filter((i) => i.code === "TYPE_MISMATCH" && i.function === "caller");
    expect(tm.length).toBeGreaterThan(0);
  });

  test("clean when caller's returns match called fn's returns", () => {
    const { issues } = go("run-query");
    const errs = issues.filter(
      (i) => i.severity === "error" && i.function === "callerOk",
    );
    expect(errs).toEqual([]);
  });
});

describe(".map(c => ({...})) bound to const (R11 bound)", () => {
  test("bound .map result is classified as literalArray, not rows<T>", () => {
    const { issues } = go("map-bound");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe(".map(c => ({...})) direct return (R11)", () => {
  test("classifies as literalArray of literal — no MISSING_FIELD against schema", () => {
    const { issues } = go("map-transform");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("nested callback returns", () => {
  test("ignores returns inside nested arrow callbacks (.map(d => return ...))", () => {
    const { issues } = go("nested-returns");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("barrel re-export", () => {
  test("follows `export { x } from \"./y\"` to the original definition", () => {
    const { codes, issues } = go("barrel-reexport");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedBalance");
  });
});

describe("const-binding for ctx.db.get", () => {
  test("traces table through `const id = args.storeId; ctx.db.get(id)`", () => {
    const { codes, issues } = go("const-binding");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("cachedAvailableBalance");
  });
});

describe("paginated (R7)", () => {
  test("diffs paginated row shape against schema", () => {
    const { codes, issues } = go("paginated");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("secret");
  });
});

describe("paginated literal page override", () => {
  test("clean — `{...result, page: literalArray}` matches validator's literal page element", () => {
    const { issues } = go("paginated-literal-page");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  test("no STALE_FIELD on validator-only fields like attachmentUrls", () => {
    const { issues } = go("paginated-literal-page");
    const stale = issues.filter((i) => i.code === "STALE_FIELD");
    expect(stale).toEqual([]);
  });
});

describe("optional add via `?.` chain", () => {
  test("no OPTIONALITY_MISMATCH on add-only field with optional-chain initializer", () => {
    const { issues } = go("optional-add");
    const opt = issues.filter((i) => i.code === "OPTIONALITY_MISMATCH");
    expect(opt).toEqual([]);
  });
});

describe("ctx.db.insert as id<T>", () => {
  test("flags id table mismatch when validator declares wrong table", () => {
    const { issues } = go("insert-id");
    const tm = issues.filter(
      (i) => i.code === "TYPE_MISMATCH" && i.function === "createPost",
    );
    expect(tm.length).toBeGreaterThan(0);
  });

  test("clean when validator's id table matches insert table", () => {
    const { issues } = go("insert-id");
    const errs = issues.filter(
      (i) => i.severity === "error" && i.function === "createPostOk",
    );
    expect(errs).toEqual([]);
  });
});

describe("empty array literal", () => {
  test("clean — `return []` matches v.array(...)", () => {
    const { issues } = go("empty-array");
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("non-null assertion (foo!)", () => {
  test("unwraps NonNullExpression to detect drift in underlying row", () => {
    const { codes, issues } = go("non-null-assert");
    expect(codes).toContain("MISSING_FIELD");
    const missing = issues.find((i) => i.code === "MISSING_FIELD")!;
    expect(missing.message).toContain("secret");
  });
});

describe("ctx.storage.generateUploadUrl + JSON.stringify", () => {
  test("flags TYPE_MISMATCH when validator wrong type for upload url string", () => {
    const { issues } = go("storage-url");
    const tm = issues.filter(
      (i) => i.code === "TYPE_MISMATCH" && i.function === "badUploadUrl",
    );
    expect(tm.length).toBeGreaterThan(0);
  });

  test("clean when validator agrees that upload url is a string", () => {
    const { issues } = go("storage-url");
    const errs = issues.filter(
      (i) => i.severity === "error" && i.function === "goodUploadUrl",
    );
    expect(errs).toEqual([]);
  });

  test("flags JSON.stringify return as string", () => {
    const { issues } = go("storage-url");
    const tm = issues.filter(
      (i) => i.code === "TYPE_MISMATCH" && i.function === "badJson",
    );
    expect(tm.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Realistic-pattern harness coverage + false-positive guards
// ─────────────────────────────────────────────────────────────────────────

describe("null-narrowing guard (C1/C3)", () => {
  test("`if (!x) throw; return x` does NOT fire NULL_BRANCH_MISSING", () => {
    expect(fnIssues("null-narrowing", "getThrow")).toEqual([]);
  });
  test("`if (x === null) throw; return x` narrows too", () => {
    expect(fnIssues("null-narrowing", "getEqNull")).toEqual([]);
  });
  test("`{ ...narrowedRow }` spread is non-null (C3)", () => {
    expect(fnIssues("null-narrowing", "getSpread")).toEqual([]);
  });
  test("explicit `return null` path STILL fires NULL_BRANCH_MISSING (guard)", () => {
    expect(fnIssues("null-narrowing", "getReturnNull").map((i) => i.code)).toContain(
      "NULL_BRANCH_MISSING",
    );
  });
  test("non-exiting guard does NOT narrow (guard)", () => {
    expect(fnIssues("null-narrowing", "getNoExit").map((i) => i.code)).toContain(
      "NULL_BRANCH_MISSING",
    );
  });
  test("combined `if (!x || cond) throw` narrows x", () => {
    expect(fnIssues("null-narrowing", "getCombined")).toEqual([]);
  });
  test("narrowing reaches an alias of the guarded var", () => {
    expect(fnIssues("null-narrowing", "getAlias")).toEqual([]);
  });
  test("narrowing reaches a destructure-rest of the guarded var", () => {
    expect(fnIssues("null-narrowing", "getRest")).toEqual([]);
  });
  test("`if (x === undefined) throw` does NOT narrow a db.get row (soundness)", () => {
    expect(fnIssues("null-narrowing", "getStrictUndef").map((i) => i.code)).toContain(
      "NULL_BRANCH_MISSING",
    );
  });
  test("unguarded `{ ...maybeNull }` is still flagged (no silent pass)", () => {
    expect(fnErrors("null-narrowing", "getUnguardedSpread").length).toBeGreaterThan(0);
  });
});

describe("nullish fallback nullability (C2)", () => {
  test("`a ?? <non-null>` → no NULL_BRANCH_MISSING", () => {
    expect(fnIssues("nullish-fallback", "fbNonNull")).toEqual([]);
  });
  test("`a ?? null` → NULL_BRANCH_MISSING (guard)", () => {
    expect(fnIssues("nullish-fallback", "fbNull").map((i) => i.code)).toContain(
      "NULL_BRANCH_MISSING",
    );
  });
  test("`a ?? <nullable>` → NULL_BRANCH_MISSING (guard)", () => {
    expect(fnIssues("nullish-fallback", "fbNullable").map((i) => i.code)).toContain(
      "NULL_BRANCH_MISSING",
    );
  });
});

describe("optionality is directional (C4)", () => {
  test("schema-required + validator-optional is NOT an error", () => {
    expect(fnErrors("optionality-direction", "widened")).toEqual([]);
  });
  test("schema-optional + validator-required IS an error", () => {
    const opt = fnIssues("optionality-direction", "narrowed").find(
      (i) => i.code === "OPTIONALITY_MISMATCH",
    );
    expect(opt).toBeDefined();
    expect(opt!.message).toContain("opt");
  });
});

describe("stale-field severity by optionality (C5)", () => {
  test("an optional stale field is info, not error", () => {
    const stale = fnIssues("stale-field-severity", "optStale").find(
      (i) => i.code === "STALE_FIELD",
    );
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe("info");
  });
});

describe("foreign-key join (B1)", () => {
  test("ctx.db.get(row.fkId) diffs the joined table's row", () => {
    const m = fnIssues("fk-join", "getAuthor").find((i) => i.code === "MISSING_FIELD");
    expect(m).toBeDefined();
    expect(m!.message).toContain("secret");
  });
});

describe("join/enrichment adds carry real shapes (B2)", () => {
  test("correct nested validator → clean (guard against over-reporting)", () => {
    expect(fnErrors("join-enrich", "getTeamOk")).toEqual([]);
  });
  test("nested validator dropping a field → TYPE_MISMATCH on the add", () => {
    const tm = fnIssues("join-enrich", "getTeamDrift").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("members");
  });
});

describe("ctx.storage.getUrl is string|null (B3)", () => {
  test("vs v.string() → TYPE_MISMATCH", () => {
    expect(fnIssues("storage-url-null", "urlBad").map((i) => i.code)).toContain("TYPE_MISMATCH");
  });
  test("vs v.union(v.string(), v.null()) → clean", () => {
    expect(fnErrors("storage-url-null", "urlOk")).toEqual([]);
  });
  test("`?? \"\"` strips the null → clean", () => {
    expect(fnErrors("storage-url-null", "urlFallback")).toEqual([]);
  });
  test("an early-exit null guard narrows the url binding → clean", () => {
    expect(fnErrors("storage-url-null", "urlGuard")).toEqual([]);
  });
});

describe("direct `return result.page` (B9)", () => {
  test("classified as rows<T> and diffed against schema", () => {
    const m = fnIssues("paginated-page-direct", "listPage").find((i) => i.code === "MISSING_FIELD");
    expect(m).toBeDefined();
    expect(m!.message).toContain("secret");
  });
});

describe("count via `.length` (B13)", () => {
  test("`rows.length` vs v.array(...) → cardinality/type mismatch", () => {
    expect(fnIssues("count-length", "countBad").map((i) => i.code)).toContain("TYPE_MISMATCH");
  });
  test("`rows.length` vs v.number() → clean", () => {
    expect(fnErrors("count-length", "countOk")).toEqual([]);
  });
});

describe("value-bounded literal returns (B17)", () => {
  test("`return \"inactive\"` vs v.literal(\"active\") → TYPE_MISMATCH", () => {
    expect(fnIssues("literal-value", "statusBad").map((i) => i.code)).toContain("TYPE_MISMATCH");
  });
  test("`return \"active\"` vs v.literal(\"active\") → clean", () => {
    expect(fnErrors("literal-value", "statusOk")).toEqual([]);
  });
  test("`return \"x\"` vs v.string() → clean", () => {
    expect(fnErrors("literal-value", "statusStr")).toEqual([]);
  });
});

describe("v.optional(...) unwrapping (B18)", () => {
  test("object inside v.optional(...) is still diffed", () => {
    const m = fnIssues("optional-unwrap", "getOpt").find((i) => i.code === "MISSING_FIELD");
    expect(m).toBeDefined();
    expect(m!.message).toContain("secret");
  });
  test("valid primitive vs v.optional(v.string()) → clean (no false positive)", () => {
    expect(fnErrors("optional-unwrap", "primOk")).toEqual([]);
  });
});

describe("opaque validator-builder branch suppresses hard mismatch (C6)", () => {
  test("v.union(doc(schema,\"t\"), v.null()) does not emit a spurious TYPE_MISMATCH", () => {
    expect(fnErrors("doc-helper", "getStore")).toEqual([]);
  });
});

describe("paginated envelope keys (B16)", () => {
  test("missing isDone + continueCursor → two MISSING_FIELD", () => {
    const missing = fnIssues("paginated-keys", "pageBad").filter((i) => i.code === "MISSING_FIELD");
    expect(missing.map((i) => i.message).join(" ")).toContain("isDone");
    expect(missing.map((i) => i.message).join(" ")).toContain("continueCursor");
  });
  test("full envelope → clean", () => {
    expect(fnErrors("paginated-keys", "pageOk")).toEqual([]);
  });
});

describe("satisfies expression unwrap (B22)", () => {
  test("drift behind `satisfies Validator<...>` is still detected", () => {
    const m = fnIssues("satisfies", "getStore").find((i) => i.code === "MISSING_FIELD");
    expect(m).toBeDefined();
    expect(m!.message).toContain("secret");
  });
});

describe("diamond shared-validator ref (C9)", () => {
  test("drift surfaces on BOTH fields that reference the same validator", () => {
    const tm = fnIssues("diamond-ref", "getRoute").filter((i) => i.code === "TYPE_MISMATCH");
    const fields = tm.map((i) => i.message);
    expect(fields.some((m) => m.includes("start"))).toBe(true);
    expect(fields.some((m) => m.includes("end"))).toBe(true);
  });
});

describe("schema spread tables (B6)", () => {
  test("a table from `...sharedTables` is resolved and diffed", () => {
    const m = fnIssues("schema-spread", "getAudit").find((i) => i.code === "MISSING_FIELD");
    expect(m).toBeDefined();
    expect(m!.message).toContain("secret");
  });
});

describe(".map(x => cond ? a : b) diffs BOTH branches (B11)", () => {
  test("the else branch's extra + missing fields are flagged", () => {
    const codes = fnIssues("realistic-followups", "mapTernary").map((i) => i.code);
    expect(codes).toContain("EXTRA_LITERAL_FIELD");
    expect(codes).toContain("MISSING_LITERAL_FIELD");
  });
});

describe("fan-out join cleaned with `.filter(d => d !== null)`", () => {
  test("null-removing filter makes the element non-null → clean", () => {
    expect(fnErrors("realistic-followups", "fanout")).toEqual([]);
  });
  // Regression: surfaced by running on get-convex/agent — a compound type-guard
  // predicate (`!== null` buried in an && chain) must also strip nullability.
  test("compound type-guard filter (agent pattern) → clean", () => {
    expect(fnErrors("realistic-followups", "fanoutCompound")).toEqual([]);
  });
});

describe("`.map` callback destructure shadows an outer variable (presence FP)", () => {
  // Surfaced by running on get-convex/presence: `list`/`listRoom`/`listUser` each
  // do `const online = ...take()` (an array) then map with a callback that
  // destructures a row field ALSO named `online` (a boolean). The shorthand in
  // the returned object must resolve to the SHADOWING destructured field, not the
  // outer array — otherwise a spurious TYPE_MISMATCH ("expected array, validator
  // has boolean") fires.
  test("destructured field shadows same-named outer rows<T> array → clean", () => {
    expect(fnErrors("shadowed-map", "shadowMap")).toEqual([]);
  });
  test("opaque element (spread-array receiver) still suppresses the FP → clean", () => {
    expect(fnErrors("shadowed-map", "shadowSpread")).toEqual([]);
  });
  // Guardrail: shadowing must not blanket-suppress real drift. A renamed
  // destructure (`_id: id`) over a known row still resolves each field to its
  // schema column shape, so a genuine type drift is still caught.
  test("renamed destructure with real column drift → still flagged", () => {
    const tm = fnIssues("shadowed-map", "shadowDrift").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("count");
    // and the renamed `id` (`_id: id` → v.id("widgets")) is NOT a false flag
    expect(
      fnIssues("shadowed-map", "shadowDrift").some((i) => i.message.includes('"id"')),
    ).toBe(false);
  });
});

describe("false negatives fixed by the sensitivity (fault-injection) audit", () => {
  // FIX A — String()/Number()/Boolean() coercion produces a definite leaf type;
  // a coerced field that drifts from the validator must be caught (was: `any`).
  test("String() coercion drift is caught", () => {
    const tm = fnIssues("false-negatives", "coerced").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("sortKey");
  });
  // FIX B — a named-reference handler imported from another file is resolved and
  // analyzed, not silently skipped (the common component `handler: fooHandler`).
  test("imported named-reference handler is resolved and its drift caught", () => {
    const tm = fnIssues("false-negatives", "getPointNamed").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("sortKey");
  });
  // FIX B guardrail — an unfollowable wrapped handler degrades to UNANALYZED
  // (honest), neither crashing nor silently passing.
  test("unfollowable wrapped handler degrades to UNANALYZED, not a silent pass", () => {
    const r = run({
      convexDir: `${FIX}false-negatives/convex`,
      schemaPath: undefined,
      includeUnanalyzed: true,
      format: "text",
      strict: false,
    });
    const codes = r.issues.filter((i) => i.function === "wrappedHandler").map((i) => i.code);
    expect(codes).toContain("UNANALYZED");
  });
  // FIX C — an extra field the handler adds, hidden behind an unresolved
  // `...schema.tables.X.validator.fields` spread, is still caught.
  test("handler extra field behind an unresolved spread is caught", () => {
    const ex = fnIssues("false-negatives", "extraBehindSpread").find((i) => i.code === "EXTRA_LITERAL_FIELD");
    expect(ex).toBeDefined();
    expect(ex!.message).toContain("bogus");
  });
  // FIX E — a `.map()` projection used as an object-field value is diffed at the
  // element level instead of flattening to `any`.
  test("`.map()` projection field element drift is caught", () => {
    const tm = fnIssues("false-negatives", "mapProjectionField").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("tag");
  });
  // FIX D — convex-helpers `doc(schema,"table")` is a single object; an array
  // return against it is a cardinality mismatch (was suppressed as opaque).
  test("doc() validator vs array return is a cardinality mismatch", () => {
    const c = fnIssues("false-negatives", "docCardinality").find((i) => i.code === "CARDINALITY_MISMATCH");
    expect(c).toBeDefined();
  });
  // FIX D guardrail — a single-doc return against doc() stays clean.
  test("doc() validator with a matching single-doc return stays clean", () => {
    expect(fnErrors("false-negatives", "docClean")).toEqual([]);
  });
  // FIX F — `.length` is a number, diffed instead of flattened to `any`.
  test("`.length` enrichment field drift is caught", () => {
    const tm = fnIssues("false-negatives", "lengthField").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("nameLen");
  });
  // FIX G — the `.map((x, i) => ...)` index param is a number.
  test("`.map` index-param projection drift is caught", () => {
    const tm = fnIssues("false-negatives", "mapIndexField").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("idx");
  });
  // id-vs-string compat — an Id satisfies a v.string() validator (not a FP).
  test("handler id vs v.string() validator stays clean (Id is a string)", () => {
    expect(fnErrors("false-negatives", "rowIdAsString")).toEqual([]);
  });
});

describe("computed string-concat enrichment field", () => {
  test("`u.first + \" \" + u.last` is a string → flagged vs v.number()", () => {
    const tm = fnIssues("realistic-followups", "enrich").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("fullName");
  });
});

describe("fix suggestions never widen the schema", () => {
  test("a literal mismatch suggests v.literal(value), not v.string()", () => {
    const i = fnIssues("literal-value", "statusBad").find((x) => x.code === "TYPE_MISMATCH")!;
    expect(i.fixCode?.after).toBe('v.literal("inactive")');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rich feedback (Bucket A)
// ─────────────────────────────────────────────────────────────────────────

describe("rule metadata registry (A1)", () => {
  test("every issue code has metadata", () => {
    const codes: IssueCode[] = [
      "MISSING_FIELD",
      "STALE_FIELD",
      "OPTIONALITY_MISMATCH",
      "TYPE_MISMATCH",
      "NULL_BRANCH_MISSING",
      "CARDINALITY_MISMATCH",
      "EXTRA_LITERAL_FIELD",
      "MISSING_LITERAL_FIELD",
      "UNANALYZED",
      "ANALYZER_ERROR",
    ];
    for (const c of codes) {
      expect(RULE_META[c]).toBeDefined();
      expect(RULE_META[c].why.length).toBeGreaterThan(10);
      expect(RULE_META[c].title.length).toBeGreaterThan(0);
    }
  });
});

describe("every emitted issue carries rich fields (A3)", () => {
  test("category + why are populated on real issues", () => {
    const { issues } = go("type-mismatch");
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.category).toBeTruthy();
      expect(i.why).toBeTruthy();
      expect(i.docUrl).toBeTruthy();
    }
  });
});

describe("field-precise pointers (A4)", () => {
  test("a row-diff issue points at the field line, not the `returns:` line", () => {
    const { issues } = go("type-mismatch");
    const fielded = issues.find((i) => i.pointerLine && i.pointerLine !== i.line);
    expect(fielded).toBeDefined();
  });
});

describe("fix synthesis is ref-safe (A5)", () => {
  test("MISSING_FIELD with a renderable schema shape carries a fixCode", () => {
    const m = go("missing-field").issues.find(
      (i) => i.code === "MISSING_FIELD" && i.message.includes("cachedAvailableBalance"),
    )!;
    expect(m.fixCode?.add).toContain("cachedAvailableBalance");
  });
  test("unresolved imported field shape → NO garbage fixCode", () => {
    const m = fnIssues("fix-ref-safe", "getStore").find((i) => i.code === "MISSING_FIELD")!;
    expect(m.fixCode).toBeUndefined();
  });
});

describe("summary + headline (A7)", () => {
  test("headline counts only error-bearing functions as affected", () => {
    const s = summarize(go("stale-field-severity").issues, 1);
    // optStale only produces an info STALE_FIELD → 0 functions will throw.
    expect(s.affectedFns).toBe(0);
    expect(s.headline).toContain("No runtime errors");
  });
  test("missing-field reports 1 affected function", () => {
    const r = runFix("missing-field");
    expect(r.summary?.affectedFns).toBe(1);
    expect(r.summary?.headline).toContain("ReturnsValidationError");
  });
});

describe("enriched JSON contract (A8)", () => {
  test("schemaVersion + summary + per-issue category are present", () => {
    const parsed = JSON.parse(reportJson(runFix("missing-field")));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.byCategory).toBeDefined();
    expect(parsed.issues[0].category).toBe("schema-drift");
  });
});

describe("rich text formatter (A6)", () => {
  test("clean run is a friendly one-liner", () => {
    const text = reportText(runFix("clean"));
    expect(text).toContain("match their returns validator");
  });
  test("dirty run includes why + fix + docs + caret", () => {
    const text = reportText(runFix("type-mismatch"));
    expect(text).toContain("why");
    expect(text).toContain("fix");
    expect(text).toContain("docs.convex.dev");
    expect(text).toContain("^");
  });
});

describe("analyzer never crashes the whole run (C10)", () => {
  // No source files at all (wrong path) → still a hard ANALYZER_ERROR.
  test("empty/wrong dir (no source files) yields an ANALYZER_ERROR, not a throw", () => {
    const r = run({
      convexDir: `${FIX}/does-not-exist/convex`,
      schemaPath: undefined,
      includeUnanalyzed: false,
      format: "text",
      strict: false,
    });
    expect(r.issues.some((i) => i.code === "ANALYZER_ERROR")).toBe(true);
  });
});

describe("schemaless project (schema.ts is optional in Convex)", () => {
  // Regression: convex-demos/args-validation has function files but no schema.ts.
  // ccv used to abort the whole run with an error-severity ANALYZER_ERROR.
  test("missing schema.ts with real functions → NOT an analyzer error", () => {
    const { issues } = go("schemaless");
    expect(issues.some((i) => i.code === "ANALYZER_ERROR")).toBe(false);
  });
  test("literal-returns drift is still caught without a schema", () => {
    const tm = fnIssues("schemaless", "badLiteral").find((i) => i.code === "TYPE_MISMATCH");
    expect(tm).toBeDefined();
    expect(tm!.message).toContain("status");
  });
  test("db-backed read degrades to UNANALYZED (conservative, not a false pass)", () => {
    const r = run({
      convexDir: `${FIX}schemaless/convex`,
      schemaPath: undefined,
      includeUnanalyzed: true,
      format: "text",
      strict: false,
    });
    const codes = r.issues.filter((i) => i.function === "listThings").map((i) => i.code);
    expect(codes).toContain("UNANALYZED");
    expect(codes).not.toContain("TYPE_MISMATCH");
  });
});
