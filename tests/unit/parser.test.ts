import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import {
  parseMarkdownPlan,
  slugify,
  calculateSourceKey,
  parseSourceKey
} from "../../src/parser.js";

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
    expect(parsed.tasks[0].sourceKey).toBe(
      "sample-plan:wave-1-foundation:impl-setup-core-types-and-interfaces:0f514299"
    );

    expect(parsed.tasks[1]).toMatchObject({
      title: "[IMPL] Initialize git repository and baseline config",
      status: "done",
      wave: "Wave 1: Foundation"
    });
    expect(parsed.tasks[1].sourceKey).toBe(
      "sample-plan:wave-1-foundation:impl-initialize-git-repository-and-baseline-config:26696627"
    );

    expect(parsed.tasks[2]).toMatchObject({
      title: "[IMPL] Implement zero-native database client",
      status: "todo",
      wave: "Wave 2: Execution"
    });
    expect(parsed.tasks[2].sourceKey).toBe(
      "sample-plan:wave-2-execution:impl-implement-zero-native-database-client:2d71f07f"
    );

    expect(parsed.tasks[3]).toMatchObject({
      title: "[IMPL] Add bidirectional markdown synchronizer",
      status: "todo",
      wave: "Wave 2: Execution"
    });
    expect(parsed.tasks[3].sourceKey).toBe(
      "sample-plan:wave-2-execution:impl-add-bidirectional-markdown-synchronizer:8564d98b"
    );
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

  describe("FSM Codeblock Fence Isolation", () => {
    it("ignores checkboxes inside triple backtick (```) and tilde (~~~) code blocks", () => {
      const markdown = `
# Plan With Code Blocks

\`\`\`markdown
- [ ] Checkbox inside preamble codeblock
- [x] Another fake checkbox in backticks
\`\`\`

## Wave 1
- [ ] **First Real Task**
  Here is an example code block with fake checkboxes:
  \`\`\`ts
  // Code snippet
  - [ ] Fake task in ts block
  * [x] Another fake checkbox
  \`\`\`
  And another with tildes:
  ~~~yaml
  - [ ] Fake task in yaml tilde block
  * [ ] Fake task 2 in yaml tilde block
  ~~~
  Task conclusion.

- [x] **Second Real Task**
  Description for second task.
`;

      const parsed = parseMarkdownPlan(markdown, "/path/to/code-plan.md");

      expect(parsed.tasks).toHaveLength(2);
      expect(parsed.tasks[0].title).toBe("First Real Task");
      expect(parsed.tasks[0].status).toBe("todo");
      expect(parsed.tasks[0].description).toContain("Here is an example code block");
      expect(parsed.tasks[0].description).toContain("- [ ] Fake task in ts block");
      expect(parsed.tasks[0].description).toContain("- [ ] Fake task in yaml tilde block");
      expect(parsed.tasks[0].description).toContain("Task conclusion.");

      expect(parsed.tasks[1].title).toBe("Second Real Task");
      expect(parsed.tasks[1].status).toBe("done");
      expect(parsed.tasks[1].description).toBe("Description for second task.");
    });
  });

  describe("Unicode Slugification & Cyrillic Support", () => {
    it("slugify handles Unicode NFKD normalization, Cyrillic, Latin, and punctuation", () => {
      expect(slugify("Волна 1: Фундамент")).toBe("волна-1-фундамент");
      expect(slugify("[IMPL] Настройка базовых типов")).toBe("impl-настроика-базовых-типов");
      expect(slugify("Café & Résumé")).toBe("cafe-resume");
      expect(slugify("  Hello   World  !!! ")).toBe("hello-world");
      expect(slugify("---")).toBe("");
    });

    it("correctly parses plans with Cyrillic headings, waves, and task titles", () => {
      const markdown = `
# План миграции системы
## Волна 1: Архитектурный базис
- [ ] **[IMPL] Создание схемы данных**
  - Where: src/db/schema.ts
  - What: Описание структуры таблиц
  - How: Использование SQL миграций
  - Expected Result: База данных успешно инициализирована
  - Why: Основа для работы сервиса
- [x] **[PLAN] Проверка требований безопасности**
  - Where: docs/security.md
  - Expected Result: Чеклист безопасности подтвержден
`;

      const parsed = parseMarkdownPlan(markdown, "/path/to/cyrillic-plan.md");

      expect(parsed.planTitle).toBe("План миграции системы");
      expect(parsed.planSlug).toBe("cyrillic-plan");
      expect(parsed.tasks).toHaveLength(2);

      const task1 = parsed.tasks[0];
      expect(task1.title).toBe("[IMPL] Создание схемы данных");
      expect(task1.wave).toBe("Волна 1: Архитектурный базис");
      expect(task1.kind).toBe("IMPL");
      expect(task1.status).toBe("todo");
      expect(task1.where).toBe("src/db/schema.ts");
      expect(task1.what).toBe("Описание структуры таблиц");
      expect(task1.how).toBe("Использование SQL миграций");
      expect(task1.expectedResult).toBe("База данных успешно инициализирована");
      expect(task1.why).toBe("Основа для работы сервиса");

      const expectedHash = crypto
        .createHash("sha256")
        .update("[impl] создание схемы данных")
        .digest("hex")
        .slice(0, 8);

      expect(task1.sourceKey).toBe(
        `cyrillic-plan:волна-1-архитектурныи-базис:impl-создание-схемы-данных:${expectedHash}`
      );

      const task2 = parsed.tasks[1];
      expect(task2.title).toBe("[PLAN] Проверка требований безопасности");
      expect(task2.status).toBe("done");
      expect(task2.where).toBe("docs/security.md");
      expect(task2.expectedResult).toBe("Чеклист безопасности подтвержден");
    });
  });

  describe("Metadata Extraction with NUL-Byte Stripping", () => {
    it("extracts Where, What, How, Expected Result, and Why while removing NUL bytes", () => {
      const markdown = `
# Plan
## Wave 1
- [ ] **Task With Metadata**
  - Where: src/\0parser.ts
  - What: Implement\0 NUL-safe parsing
  - How: Use \0regular expressions
  - Expected Result: All \0tests pass cleanly
  - Why: Avoid SQLite\0 binary string corruption
`;

      const parsed = parseMarkdownPlan(markdown, "/path/to/meta-plan.md");

      expect(parsed.tasks).toHaveLength(1);
      const task = parsed.tasks[0];
      expect(task.where).toBe("src/parser.ts");
      expect(task.what).toBe("Implement NUL-safe parsing");
      expect(task.how).toBe("Use regular expressions");
      expect(task.expectedResult).toBe("All tests pass cleanly");
      expect(task.why).toBe("Avoid SQLite binary string corruption");

      // Verify no NUL bytes in any extracted string
      expect(task.where).not.toContain("\0");
      expect(task.what).not.toContain("\0");
      expect(task.how).not.toContain("\0");
      expect(task.expectedResult).not.toContain("\0");
      expect(task.why).not.toContain("\0");
    });
  });

  describe("Deterministic source_key & Collision Resolution", () => {
    it("preserves source_key invariance when adding or reordering other tasks", () => {
      const basePlan = `
# Invariant Plan
## Wave 1
- [ ] **Task Alpha**
- [ ] **Task Omega**
`;

      const modifiedPlan = `
# Invariant Plan
## Wave 1
- [ ] **Task Alpha**
- [ ] **Newly Inserted Beta**
- [ ] **Newly Inserted Gamma**
- [ ] **Task Omega**
`;

      const reorderedPlan = `
# Invariant Plan
## Wave 1
- [ ] **Task Omega**
- [ ] **Task Alpha**
`;

      const base = parseMarkdownPlan(basePlan, "/plans/test.md");
      const modified = parseMarkdownPlan(modifiedPlan, "/plans/test.md");
      const reordered = parseMarkdownPlan(reorderedPlan, "/plans/test.md");

      const baseAlpha = base.tasks.find((t) => t.title === "Task Alpha")!;
      const baseOmega = base.tasks.find((t) => t.title === "Task Omega")!;

      const modAlpha = modified.tasks.find((t) => t.title === "Task Alpha")!;
      const modOmega = modified.tasks.find((t) => t.title === "Task Omega")!;

      const reordAlpha = reordered.tasks.find((t) => t.title === "Task Alpha")!;
      const reordOmega = reordered.tasks.find((t) => t.title === "Task Omega")!;

      expect(modAlpha.sourceKey).toBe(baseAlpha.sourceKey);
      expect(modOmega.sourceKey).toBe(baseOmega.sourceKey);

      expect(reordAlpha.sourceKey).toBe(baseAlpha.sourceKey);
      expect(reordOmega.sourceKey).toBe(baseOmega.sourceKey);
    });

    it("generates :2, :3 suffix for duplicate titles within the same wave without suffix for unique tasks", () => {
      const markdown = `
# Duplicate Title Plan
## Wave 1: First Wave
- [ ] **Duplicate Task**
- [ ] **Unique Task**
- [ ] **Duplicate Task**
- [ ] **Duplicate Task**

## Wave 2: Second Wave
- [ ] **Duplicate Task**
`;

      const parsed = parseMarkdownPlan(markdown, "/plans/dup-plan.md");
      expect(parsed.tasks).toHaveLength(5);

      const [dup1, unique, dup2, dup3, wave2Dup] = parsed.tasks;

      // First occurrence in Wave 1: no counter suffix
      const directKey = calculateSourceKey(
        "dup-plan",
        "wave-1-first-wave",
        "Duplicate Task",
        1
      );
      expect(dup1.sourceKey).toBe(directKey);
      expect(dup1.sourceKey).toMatch(/^dup-plan:wave-1-first-wave:duplicate-task:[a-f0-9]{8}$/);
      expect(dup1.sourceKey).not.toContain(":2");

      // Unique task in Wave 1: no counter suffix
      expect(unique.sourceKey).toMatch(/^dup-plan:wave-1-first-wave:unique-task:[a-f0-9]{8}$/);

      // Second occurrence in Wave 1: has :2 suffix
      expect(dup2.sourceKey).toBe(`${dup1.sourceKey}:2`);

      // Third occurrence in Wave 1: has :3 suffix
      expect(dup3.sourceKey).toBe(`${dup1.sourceKey}:3`);

      // In Wave 2: first occurrence in that wave, so no suffix!
      expect(wave2Dup.sourceKey).toMatch(/^dup-plan:wave-2-second-wave:duplicate-task:[a-f0-9]{8}$/);
      expect(wave2Dup.sourceKey).not.toContain(":2");
    });

    it("parses source_key components accurately", () => {
      const parsed = parseSourceKey("sample-plan:wave-1:my-task:abcdef12:2");
      expect(parsed).toEqual({
        planSlug: "sample-plan",
        waveSlug: "wave-1",
        titleSlug: "my-task",
        hash8: "abcdef12",
        disambiguationIndex: 2
      });

      const parsedNoSuffix = parseSourceKey("sample-plan:wave-1:my-task:abcdef12");
      expect(parsedNoSuffix).toEqual({
        planSlug: "sample-plan",
        waveSlug: "wave-1",
        titleSlug: "my-task",
        hash8: "abcdef12",
        disambiguationIndex: 1
      });
    });
  });
});
