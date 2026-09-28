import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

describe("omo-codeg CLI Binary", () => {
  const cliPath = path.resolve(__dirname, "../../bin/omo-codeg");

  it("prints help information via --help", async () => {
    const { stdout } = await execFileAsync(cliPath, ["--help"]);
    expect(stdout).toContain("Oh My OpenAgent to Codeg Bridge CLI");
    expect(stdout).toContain("sync");
    expect(stdout).toContain("diff");
    expect(stdout).toContain("status");
    expect(stdout).toContain("doctor");
  });

  it("runs doctor command successfully", async () => {
    const { stdout } = await execFileAsync(cliPath, ["doctor"]);
    expect(stdout).toContain("=== omo-codeg doctor ===");
    expect(stdout).toContain("Zero native dependencies check: PASSED");
  });
});
