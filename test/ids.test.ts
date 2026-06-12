import { describe, expect, it } from "vitest";
import { isExternalId, makeExternalId, makeNodeId, OrdinalCounter, parseNodeId } from "../src/map/ids.js";

describe("node IDs", () => {
  it("round-trips a method id", () => {
    const id = makeNodeId("ts", "src/db/userRepo.ts", "UserRepo.save");
    expect(id).toBe("ts:src/db/userRepo.ts#UserRepo.save");
    expect(parseNodeId(id)).toEqual({
      lang: "ts",
      file: "src/db/userRepo.ts",
      qualifiedName: "UserRepo.save",
      ordinal: 1,
    });
  });

  it("round-trips a file id (no qualified name)", () => {
    const id = makeNodeId("py", "pkg/__init__.py");
    expect(id).toBe("py:pkg/__init__.py");
    expect(parseNodeId(id)).toEqual({ lang: "py", file: "pkg/__init__.py", qualifiedName: "", ordinal: 1 });
  });

  it("adds ~N only for duplicates", () => {
    expect(makeNodeId("py", "a.py", "f", 1)).toBe("py:a.py#f");
    expect(makeNodeId("py", "a.py", "f", 2)).toBe("py:a.py#f~2");
    expect(parseNodeId("py:a.py#f~2")).toEqual({ lang: "py", file: "a.py", qualifiedName: "f", ordinal: 2 });
  });

  it("ordinal counter counts per qualified name in source order", () => {
    const c = new OrdinalCounter();
    expect(c.next("f")).toBe(1);
    expect(c.next("g")).toBe(1);
    expect(c.next("f")).toBe(2);
  });

  it("external ids", () => {
    expect(makeExternalId("ts", "react")).toBe("ts:ext:react");
    expect(isExternalId("ts:ext:react")).toBe(true);
    expect(isExternalId("ts:src/ext.ts#x")).toBe(false);
  });

  it("rejects malformed ids", () => {
    expect(parseNodeId("go:main.go#main")).toBeNull();
    expect(parseNodeId("nonsense")).toBeNull();
  });
});
