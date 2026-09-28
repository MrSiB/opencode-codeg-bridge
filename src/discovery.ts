import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PlanNotFoundError, DatabaseNotFoundError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface DiscoveryOptions {
  explicitDbPath?: string;
  explicitPlanPath?: string;
  explicitWorkspace?: string;
  cwd?: string;
}

export interface DiscoveredEnvironment {
  dbPath: string;
  planPath?: string;
  workspacePath: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function resolveWorkspaceFolder(
  explicitWorkspace?: string,
  cwd: string = process.cwd()
): Promise<string> {
  if (explicitWorkspace) {
    return path.resolve(explicitWorkspace);
  }

  if (process.env.CODEG_WORKSPACE && (await dirExists(process.env.CODEG_WORKSPACE))) {
    return path.resolve(process.env.CODEG_WORKSPACE);
  }

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd
    });
    const gitRoot = stdout.trim();
    if (gitRoot && (await dirExists(gitRoot))) {
      return gitRoot;
    }
  } catch {
    // Non-git directory, fallback to cwd
  }

  return path.resolve(cwd);
}

export async function findCodegDatabase(
  explicitDbPath?: string,
  cwd: string = process.cwd()
): Promise<string> {
  if (explicitDbPath) {
    const resolved = path.resolve(explicitDbPath);
    if (await fileExists(resolved)) {
      return resolved;
    }
    throw new DatabaseNotFoundError(`Explicit Codeg database not found at: ${resolved}`, {
      details: { dbPath: resolved }
    });
  }

  if (process.env.CODEG_DB_PATH) {
    const envPath = path.resolve(process.env.CODEG_DB_PATH);
    if (await fileExists(envPath)) {
      return envPath;
    }
  }

  const candidatePaths = [
    path.join(cwd, "codeg.db"),
    "/opt/codeg/data/codeg.db",
    path.join(os.homedir(), ".local/share/codeg/codeg.db"),
    path.join(os.homedir(), ".codeg/data/codeg.db")
  ];

  for (const candidate of candidatePaths) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new DatabaseNotFoundError(
    "Could not locate Codeg database (codeg.db). Specify path via --db or CODEG_DB_PATH."
  );
}

export async function findPlanFile(
  explicitPlanPath?: string,
  workspaceRoot?: string,
  cwd: string = process.cwd()
): Promise<string | undefined> {
  if (explicitPlanPath) {
    const resolved = path.resolve(explicitPlanPath);
    if (await fileExists(resolved)) {
      return resolved;
    }
    throw new PlanNotFoundError(`Explicit plan file not found at: ${resolved}`, {
      details: { planPath: resolved }
    });
  }

  const baseDir = workspaceRoot || cwd;

  const boulderPath = path.join(baseDir, ".omo/boulder.json");
  if (await fileExists(boulderPath)) {
    try {
      const boulderRaw = await fs.readFile(boulderPath, "utf-8");
      const boulder = JSON.parse(boulderRaw);
      if (boulder.active_plan && (await fileExists(boulder.active_plan))) {
        return boulder.active_plan;
      }
    } catch {
      // Fallback to searching directory
    }
  }

  const plansDir = path.join(baseDir, ".omo/plans");
  if (await dirExists(plansDir)) {
    const entries = await fs.readdir(plansDir, { withFileTypes: true });
    const markdownFiles: { file: string; mtime: number }[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const fullPath = path.join(plansDir, entry.name);
        const stat = await fs.stat(fullPath);
        markdownFiles.push({ file: fullPath, mtime: stat.mtimeMs });
      }
    }

    if (markdownFiles.length > 0) {
      markdownFiles.sort((a, b) => b.mtime - a.mtime);
      return markdownFiles[0].file;
    }
  }

  return undefined;
}

export async function discoverEnvironment(
  options: DiscoveryOptions = {}
): Promise<DiscoveredEnvironment> {
  const cwd = options.cwd || process.cwd();
  const workspacePath = await resolveWorkspaceFolder(options.explicitWorkspace, cwd);
  const dbPath = await findCodegDatabase(options.explicitDbPath, cwd);
  const planPath = await findPlanFile(options.explicitPlanPath, workspacePath, cwd);

  return {
    dbPath,
    planPath,
    workspacePath
  };
}
