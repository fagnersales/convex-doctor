import { describe, test, expect } from "bun:test";
import { run } from "../src/scan.ts";
import type { CallGraph, RunOptions } from "../src/types.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

function runGraph(extra?: Partial<RunOptions>): CallGraph {
  const opts: RunOptions = {
    convexDir: `${FIX}dead-graph/convex`,
    projectRoot: `${FIX}dead-graph`,
    schemaPath: undefined,
    includeUnanalyzed: false,
    format: "text",
    strict: false,
    lint: false,
    buildGraph: true,
    ...extra,
  };
  const graph = run(opts).graph;
  if (!graph) throw new Error("expected run() to produce a graph");
  return graph;
}

describe("dead-function graph", () => {
  const g = runGraph({ ignoreDead: ["funcs:ignoredParent"] });
  const node = (id: string) => g.nodes.find((n) => n.id === id);

  test("directly-unreferenced function is dead", () => {
    expect(g.dead).toContain("funcs:deadDirect");
    expect(g.deadTransitive).not.toContain("funcs:deadDirect");
  });

  test("function referenced only by a dead function is dead (transitive)", () => {
    expect(g.dead).toContain("funcs:deadParent");
    expect(g.dead).toContain("funcs:deadHelper");
    expect(g.deadTransitive).toContain("funcs:deadHelper");
    expect(g.deadTransitive).not.toContain("funcs:deadParent");
  });

  test("a self-call grants no life", () => {
    expect(g.dead).toContain("funcs:selfLoop");
    expect(g.deadTransitive).toContain("funcs:selfLoop");
    // The self-edge still shows up as a reference count, just not as life.
    expect(node("funcs:selfLoop")?.incoming).toBe(1);
  });

  test("externally-referenced function is alive", () => {
    expect(g.dead).not.toContain("funcs:alive");
  });

  test("string reference (`convex run \"funcs:stringCalled\"`) counts as a caller", () => {
    expect(g.dead).not.toContain("funcs:stringCalled");
    const edge = g.edges.find((e) => e.to === "funcs:stringCalled");
    expect(edge?.via).toBe("string-ref");
    expect(edge?.from.startsWith("external:")).toBe(true);
  });

  test("non-function colon strings create no edges", () => {
    const stringEdges = g.edges.filter((e) => e.via === "string-ref");
    expect(stringEdges).toHaveLength(1);
  });

  test("`convex-doctor: keep` comment keeps the function and its callees alive", () => {
    expect(g.dead).not.toContain("funcs:keptFn");
    expect(g.dead).not.toContain("funcs:keptHelper");
    expect(node("funcs:keptFn")?.kept).toBe(true);
    expect(node("funcs:keptHelper")?.kept).toBeUndefined();
  });

  test("--ignore-dead nodes are live roots: their callees stay alive", () => {
    expect(g.dead).not.toContain("funcs:ignoredParent");
    expect(g.dead).not.toContain("funcs:ignoredHelper");
    expect(node("funcs:ignoredParent")?.ignored).toBe(true);
  });

  test("dead list is exactly the unreachable set", () => {
    expect([...g.dead].sort()).toEqual([
      "funcs:deadDirect",
      "funcs:deadHelper",
      "funcs:deadParent",
      "funcs:selfLoop",
    ]);
  });
});

describe("dead-function graph without ignore patterns", () => {
  const g = runGraph();

  test("un-ignored parent and its helper both go dead", () => {
    expect(g.dead).toContain("funcs:ignoredParent");
    expect(g.dead).toContain("funcs:ignoredHelper");
    expect(g.deadTransitive).toContain("funcs:ignoredHelper");
  });

  test("kept function still alive without any flags", () => {
    expect(g.dead).not.toContain("funcs:keptFn");
    expect(g.dead).not.toContain("funcs:keptHelper");
  });
});
