import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { parseMarkdownPlan } from "../../src/parser.js";

describe("AST Markdown Plan Parser", () => {
  it("parses sample plan fixture with waves, bold titles and descriptions", async () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/sample-plan.md");
    const content = await fs.readFile(fixturePath, "utf-8");

    const parsed = parseMarkdownPlan(content, fixturePath);

    expect(parsed.planTitle).toBe("Multi-Wave Test Plan");
    expect(parsed.planSlug).toBe("sample-plan");
    expect(parsed.tasks.length).toBe(4);

    expect(parsed.tasks[0]).toMatchObject({
      title: "[IMPL] Setup core types and interfaces",
      status: "todo",
      wave: "Wave 1: Foundation"
    });
    expect(parsed.tasks[0].description).toContain("Implement basic data structures and contracts.");
    expect(parsed.tasks[0].sourceKey).toMatch(/^sample-plan:1:[a-f0-9]{8}$/);

    expect(parsed.tasks[1]).toMatchObject({
      title: "[IMPL] Initialize git repository and baseline config",
      status: "done",
      wave: "Wave 1: Foundation"
    });
    expect(parsed.tasks[1].sourceKey).toMatch(/^sample-plan:2:[a-f0-9]{8}$/);

    expect(parsed.tasks[2]).toMatchObject({
      title: "[IMPL] Implement zero-native database client",
      status: "todo",
      wave: "Wave 2: Execution"
    });
    expect(parsed.tasks[2].sourceKey).toMatch(/^sample-plan:3:[a-f0-9]{8}$/);
  });

  it("handles empty files or documents without tasks gracefully", () => {
    const parsed = parseMarkdownPlan("# Just a Title\n\nSome text.", "/tmp/notes.md");
    expect(parsed.planTitle).toBe("Just a Title");
    expect(parsed.tasks).toHaveLength(0);
  });

  it("produces deterministic source keys across multiple parse runs", () => {
    const markdown = `
# Plan
## Wave 1
- [ ] **[IMPL] Stable Task Title**
  - Details
    `;

    const run1 = parseMarkdownPlan(markdown, "/path/to/my-plan.md");
    const run2 = parseMarkdownPlan(markdown, "/path/to/my-plan.md");

    expect(run1.tasks[0].sourceKey).toBe(run2.tasks[0].sourceKey);
  });
});
