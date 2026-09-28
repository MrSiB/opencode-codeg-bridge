import crypto from "node:crypto";
import path from "node:path";
import type { ParsedPlan, PlanTask, PlanWave, SourceKeyComponents, TaskKind } from "./types.js";

const HEADER_WAVE_REGEX = /^(#{1,3})\s+(?:(Wave|Волна)\s+(\d+|[а-яёА-ЯЁa-zA-Z0-9]+)[:\s-]*)?(.*)$/iu;
const TASK_CHECKBOX_REGEX = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const TASK_BOLD_TITLE_REGEX = /^\*\*([^*]+)\*\*(?::?\s*(.*))?$/;
const METADATA_LINE_REGEX = /^(?:[-*]\s+)?(?:\*\*)?(where|what|how|why|expected\s+result)(?::\*\*|\*\*:|:)\s*(.*)$/i;

/**
 * Unicode-aware slugification with NFKD normalization.
 * - Supports Unicode normalization (NFKD).
 * - Preserves Cyrillic and Latin alphanumeric characters (\p{L}\p{N}).
 * - Replaces whitespace and punctuation with hyphens.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export const cleanSlug = slugify;

/**
 * Calculates deterministic task source_key.
 * Base hash: crypto.createHash("sha256").update(title.trim().toLowerCase()).digest("hex").slice(0, 8).
 * Format: ${planSlug}:${waveSlug}:${titleSlug}:${hash8} or ${planSlug}:${waveSlug}:${titleSlug}:${hash8}:${counter}
 */
export function calculateSourceKey(
  planSlug: string,
  waveSlug: string,
  title: string,
  counter = 1
): string {
  const normTitle = title.trim().toLowerCase();
  const hash8 = crypto.createHash("sha256").update(normTitle).digest("hex").slice(0, 8);
  const titleSlug = slugify(title) || "task";
  const baseKey = `${planSlug}:${waveSlug}:${titleSlug}:${hash8}`;
  return counter > 1 ? `${baseKey}:${counter}` : baseKey;
}

export function parseSourceKey(sourceKey: string): SourceKeyComponents | null {
  const parts = sourceKey.split(":");
  if (parts.length < 4) return null;
  const planSlug = parts[0];
  const waveSlug = parts[1];
  const titleSlug = parts[2];
  const hash8 = parts[3];
  const disambiguationIndex = parts[4] ? parseInt(parts[4], 10) : 1;
  return {
    planSlug,
    waveSlug,
    titleSlug,
    hash8,
    disambiguationIndex: isNaN(disambiguationIndex) ? 1 : disambiguationIndex
  };
}

function parseMetadataLine(line: string, task: PlanTask): boolean {
  const match = line.trim().match(METADATA_LINE_REGEX);
  if (!match) return false;

  const key = match[1].toLowerCase().replace(/\s+/g, "");
  const value = match[2].replace(/\0/g, "").trim();

  switch (key) {
    case "where":
      task.where = value;
      return true;
    case "what":
      task.what = value;
      return true;
    case "how":
      task.how = value;
      return true;
    case "why":
      task.why = value;
      return true;
    case "expectedresult":
      task.expectedResult = value;
      return true;
    default:
      return false;
  }
}

export function parseMarkdownPlan(content: string, planPath: string): ParsedPlan {
  const planSlug = slugify(path.basename(planPath, path.extname(planPath))) || "plan";
  const lines = content.replace(/\0/g, "").split(/\r?\n/);

  let planTitle = planSlug;
  let planTitleFound = false;
  let currentWave = "Default";
  const tasks: PlanTask[] = [];

  // Scoped title occurrence tracking per wave for collision resolution
  const waveTitleCounts = new Map<string, Map<string, number>>();

  let currentTask: PlanTask | null = null;
  let descriptionLines: string[] = [];
  let taskIndex = 0;

  // Code block fence FSM state
  let fenceChar: string | null = null;
  let fenceLength = 0;

  function flushCurrentTask(): void {
    if (currentTask) {
      currentTask.description = descriptionLines.join("\n").trim();
      tasks.push(currentTask);
      currentTask = null;
      descriptionLines = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // 1. Code block fence FSM: ``` or ~~~
    if (fenceChar === null) {
      const openFenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      if (openFenceMatch) {
        fenceChar = openFenceMatch[1][0];
        fenceLength = openFenceMatch[1].length;
        if (currentTask) {
          descriptionLines.push(rawLine.trim());
        }
        continue;
      }
    } else {
      const closeFenceMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (
        closeFenceMatch &&
        closeFenceMatch[1][0] === fenceChar &&
        closeFenceMatch[1].length >= fenceLength
      ) {
        fenceChar = null;
        fenceLength = 0;
        if (currentTask) {
          descriptionLines.push(rawLine.trim());
        }
        continue;
      }

      // Inside codeblock: ignore checkboxes and headers completely
      if (currentTask) {
        descriptionLines.push(rawLine.trim());
      }
      continue;
    }

    // 2. Plan title detection
    if (!planTitleFound && trimmed.startsWith("# ") && !trimmed.startsWith("##")) {
      planTitle = trimmed.substring(2).trim();
      planTitleFound = true;
      continue;
    }

    // 3. Wave header detection
    const headerMatch = trimmed.match(HEADER_WAVE_REGEX);
    if (headerMatch && !trimmed.startsWith("- [") && !trimmed.startsWith("* [")) {
      flushCurrentTask();
      const waveKeyword = headerMatch[2];
      const waveNumber = headerMatch[3];
      const sectionName = headerMatch[4]?.trim();
      if (waveNumber) {
        currentWave = `${waveKeyword || "Wave"} ${waveNumber}${sectionName ? `: ${sectionName}` : ""}`;
      } else if (sectionName) {
        currentWave = sectionName;
      }
      continue;
    }

    // 4. Task checkbox detection
    const checkboxMatch = trimmed.match(TASK_CHECKBOX_REGEX);
    if (checkboxMatch) {
      flushCurrentTask();
      taskIndex++;

      const isChecked = checkboxMatch[1].toLowerCase() === "x";
      const rest = checkboxMatch[2].trim();

      let title = rest;
      let initialDesc = "";

      const boldMatch = rest.match(TASK_BOLD_TITLE_REGEX);
      if (boldMatch) {
        title = boldMatch[1].trim();
        if (boldMatch[2]) {
          initialDesc = boldMatch[2].trim();
        }
      }

      title = title.replace(/\0/g, "").trim();
      const kind: TaskKind = title.toUpperCase().includes("[IMPL]") ? "IMPL" : "PLAN";

      const waveSlug = slugify(currentWave) || "default";
      const normTitle = title.trim().toLowerCase();

      let titleMap = waveTitleCounts.get(waveSlug);
      if (!titleMap) {
        titleMap = new Map<string, number>();
        waveTitleCounts.set(waveSlug, titleMap);
      }
      const count = (titleMap.get(normTitle) || 0) + 1;
      titleMap.set(normTitle, count);

      const sourceKey = calculateSourceKey(planSlug, waveSlug, title, count);

      currentTask = {
        id: String(taskIndex),
        title,
        description: initialDesc,
        kind,
        status: isChecked ? "done" : "todo",
        wave: currentWave,
        order: taskIndex,
        sourceKey
      };

      if (initialDesc) {
        descriptionLines.push(initialDesc);
        parseMetadataLine(initialDesc, currentTask);
      }
      continue;
    }

    // 5. Task description and metadata handling
    if (currentTask) {
      const isMeta = parseMetadataLine(trimmed, currentTask);

      if (
        rawLine.startsWith("  ") ||
        rawLine.startsWith("\t") ||
        trimmed.startsWith("- ") ||
        trimmed.startsWith("* ") ||
        isMeta
      ) {
        descriptionLines.push(rawLine.trim());
      } else if (trimmed === "") {
        descriptionLines.push("");
      } else {
        flushCurrentTask();
      }
    }
  }

  flushCurrentTask();

  const waveMap = new Map<string, PlanTask[]>();
  for (const t of tasks) {
    const w = String(t.wave || "Default");
    if (!waveMap.has(w)) waveMap.set(w, []);
    waveMap.get(w)!.push(t);
  }
  const waves: PlanWave[] = Array.from(waveMap.entries()).map(([title, waveTasks], idx) => ({
    wave: idx + 1,
    title,
    tasks: waveTasks
  }));

  return {
    slug: planSlug,
    planSlug,
    title: planTitle,
    planTitle,
    path: planPath,
    planPath,
    tasks,
    waves
  };
}
