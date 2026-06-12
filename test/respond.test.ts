import { describe, expect, it } from "vitest";
import { respond, respondError } from "../src/respond.js";

const ref = (i: number) => ({
  file: `src/mod${i % 7}.ts`,
  line: i + 1,
  col: 5,
  snippet: `const x${i} = call(${i}); // some representative line of code here`,
});

describe("respond", () => {
  it("returns untruncated when under budget", () => {
    const env = respond({ locations: [ref(1), ref(2)] }, { budget: 2000 });
    expect(env.ok).toBe(true);
    expect(env.truncated).toBe(false);
    expect(env.dropped).toBeUndefined();
    expect(env.tokenBudget.used).toBeLessThanOrEqual(2000);
    expect((env.data as any).locations).toHaveLength(2);
  });

  it("truncates a declared array to fit the budget and notes what was dropped", () => {
    const locations = Array.from({ length: 200 }, (_, i) => ref(i));
    const env = respond(
      { target: ref(0), locations },
      {
        budget: 500,
        truncatable: [{ path: "locations", kind: "references", recoverHint: "Pass fileFilter to scope results." }],
      },
    );
    expect(env.truncated).toBe(true);
    const kept = (env.data as any).locations.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(200);
    expect(env.dropped!.count).toBe(200 - kept);
    expect(env.dropped!.note).toContain("fileFilter");
    expect(env.tokenBudget.used).toBeLessThanOrEqual(500);
  });

  it("applies the ranker before cutting", () => {
    const items = [
      { name: "low", score: 1, pad: "x".repeat(200) },
      { name: "high", score: 9, pad: "x".repeat(200) },
      { name: "mid", score: 5, pad: "x".repeat(200) },
    ];
    const env = respond(
      { items },
      {
        budget: 150,
        truncatable: [{ path: "items", kind: "items", ranker: (a, b) => b.score - a.score }],
      },
    );
    const kept = (env.data as any).items;
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept[0].name).toBe("high");
  });

  it("clamps the requested budget to [100, 10000]", () => {
    const env = respond({ v: 1 }, { budget: 5 });
    expect(env.tokenBudget.requested).toBe(5); // echoed as asked
    // but a tiny payload passes because the effective floor is 100
    expect(env.truncated).toBe(false);
  });

  it("elides snippets as a last resort", () => {
    // one giant untruncatable item
    const env = respond(
      { target: { file: "a.ts", line: 1, col: 1, snippet: "y".repeat(4000) } },
      { budget: 100 },
    );
    expect(env.truncated).toBe(true);
    expect((env.data as any).target.snippet).toBeUndefined();
  });

  it("does not mutate the caller's data", () => {
    const locations = Array.from({ length: 50 }, (_, i) => ref(i));
    const data = { locations };
    respond(data, { budget: 200, truncatable: [{ path: "locations", kind: "refs" }] });
    expect(data.locations).toHaveLength(50);
  });

  it("nested truncatable paths work", () => {
    const env = respond(
      { graph: { nodes: Array.from({ length: 100 }, (_, i) => ref(i)) } },
      { budget: 300, truncatable: [{ path: "graph.nodes", kind: "nodes" }] },
    );
    expect(env.truncated).toBe(true);
    expect((env.data as any).graph.nodes.length).toBeLessThan(100);
  });
});

describe("respondError", () => {
  it("builds an ok:false envelope with code and extras", () => {
    const env = respondError("LSP_UNAVAILABLE", "pyright not found", {
      hint: "npm i -g pyright",
      language: "py",
    });
    expect(env.ok).toBe(false);
    expect(env.error!.code).toBe("LSP_UNAVAILABLE");
    expect(env.error!.hint).toContain("pyright");
    expect(env.error!.language).toBe("py");
    expect(env.tokenBudget.used).toBeGreaterThan(0);
  });
});
