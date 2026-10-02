import { describe, expect, it } from "vitest";
import { localFileTarget } from "../src/fileLinks";

describe("local file links", () => {
  it("recognizes absolute paths and line suffixes", () => {
    expect(localFileTarget("/home/jakob/project/src/app.ts:42", "/tmp")).toEqual({
      path: "/home/jakob/project/src/app.ts",
      line: 42,
    });
  });

  it("resolves relative and file URI links", () => {
    expect(localFileTarget("../README.md", "/home/jakob/project/src")).toEqual({
      path: "/home/jakob/project/README.md",
    });
    expect(localFileTarget("file:///home/jakob/My%20Project/app.ts#L7", "/tmp")).toEqual({
      path: "/home/jakob/My Project/app.ts",
      line: 7,
    });
  });

  it("leaves web and mail links alone", () => {
    expect(localFileTarget("https://example.com", "/tmp")).toBeNull();
    expect(localFileTarget("mailto:user@example.com", "/tmp")).toBeNull();
  });
});
