import crypto from "node:crypto";
import path from "node:path";
import type { ParsedPlan, PlanTask, TaskKind } from "./types.js";

const HEADER_WAVE_REGEX = /^(#{1,3})\s+(?:Wave\s+(\d+|[A-Z0-9]+)[:\s-]*)?(.*)$/i;
const TASK_CHECKBOX_REGEX = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const TASK_BOLD_TITLE_REGEX = /^\*\*([^*]+)\*\*(?::?\s*(.*))?$/;

function cleanSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function calculateSourceKey(planSlug: string, taskIndex: number, title: string): string {
  const normTitle = title.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(normTitle).digest("hex").slice(0, 8);
  return `${planSlug}:${taskIndex}:${hash}`;
}

export function parseMarkdownPlan(content: string, planPath: string): ParsedPlan {
  const planSlug = cleanSlug(path.basename(planPath, path.extname(planPath)));
  const lines = content.split(/\r?\n/);

  let planTitle = planSlug;
  let currentWave = "Default";
  const tasks: PlanTask[] = [];

  let currentTask: PlanTask | null = null;
  let descriptionLines: string[] = [];
  let taskIndex = 0;

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

    if (i === 0 && trimmed.startsWith("# ")) {
      planTitle = trimmed.substring(2).trim();
      continue;
    }

    const headerMatch = trimmed.match(HEADER_WAVE_REGEX);
    if (headerMatch && !trimmed.startsWith("- [")) {
      flushCurrentTask();
      const waveNumber = headerMatch[2];
      const sectionName = headerMatch[3]?.trim();
      if (waveNumber) {
        currentWave = `Wave ${waveNumber}${sectionName ? `: ${sectionName}` : ""}`;
      } else if (sectionName) {
        currentWave = sectionName;
      }
      continue;
    }

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

      const kind: TaskKind = title.toUpperCase().includes("[IMPL]") ? "IMPL" : "PLAN";

      currentTask = {
        id: String(taskIndex),
        title,
        description: initialDesc,
        kind,
        status: isChecked ? "done" : "todo",
        wave: currentWave,
        order: taskIndex,
        sourceKey: calculateSourceKey(planSlug, taskIndex, title)
      };

      if (initialDesc) {
        descriptionLines.push(initialDesc);
      }
      continue;
    }

    if (currentTask) {
      if (rawLine.startsWith("  ") || rawLine.startsWith("\t") || trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        descriptionLines.push(rawLine.trim());
      } else if (trimmed === "") {
        descriptionLines.push("");
      } else {
        flushCurrentTask();
      }
    }
  }

  flushCurrentTask();

  return {
    slug: planSlug,
    planSlug,
    title: planTitle,
    planTitle,
    path: planPath,
    planPath,
    tasks
  };
}
