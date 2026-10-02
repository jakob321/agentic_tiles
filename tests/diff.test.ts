import { describe, expect, it } from "vitest";
import { diffCounts, diffLineKind } from "../src/components/ChatView";

const sample = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,2 +1,3 @@",
  "-const oldValue = 1;",
  "+const newValue = 2;",
  "+const enabled = true;",
  " unchanged();",
].join("\n");

describe("unified diff display", () => {
  it("counts changed source lines without counting file headers", () => {
    expect(diffCounts(sample)).toEqual({ additions: 2, deletions: 1 });
  });

  it("classifies headers, hunks, additions, deletions, and context", () => {
    expect(diffLineKind("+++ b/example.ts")).toBe("meta");
    expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffLineKind("+new line")).toBe("add");
    expect(diffLineKind("-old line")).toBe("delete");
    expect(diffLineKind(" unchanged")).toBe("context");
  });
});
