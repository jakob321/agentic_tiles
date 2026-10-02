import { describe, expect, it } from "vitest";
import { dedupeThreads } from "../src/store";
import type { ThreadSummary } from "../src/types";

const base: ThreadSummary = {
  id: "thread-a",
  preview: "Conversation",
  cwd: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: { type: "idle" },
};

describe("thread list deduplication", () => {
  it("keeps only the first occurrence of each thread id", () => {
    const result = dedupeThreads([
      base,
      { ...base, id: "thread-b", preview: "Another" },
      { ...base, preview: "Duplicate from a later page" },
    ]);

    expect(result.map((thread) => thread.id)).toEqual(["thread-a", "thread-b"]);
    expect(result[0].preview).toBe("Conversation");
  });
});
