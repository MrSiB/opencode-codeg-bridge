import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeCodegBridgePlugin, runCli } from "../../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");

describe("Package Scaffolding Verification", () => {
  it("has valid package.json with required fields and dependencies", () => {
    const pkgPath = resolve(pkgRoot, "package.json");
    expect(existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(pkg.name).toBe("opencode-codeg-bridge");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toHaveProperty("@opencode-ai/plugin");
    expect(pkg.devDependencies).toHaveProperty("vitest");
    expect(pkg.devDependencies).toHaveProperty("typescript");
    expect(pkg.bin).toHaveProperty("omo-codeg");
  });

  it("strictly enforces zero native C++ dependencies", () => {
    const pkgPath = resolve(pkgRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };

    const forbiddenNativePackages = [
      "better-sqlite3",
      "sqlite3",
      "node-gyp",
      "nan",
      "bindings",
      "node-pre-gyp",
      "@mapbox/node-pre-gyp",
      "canvas",
      "fsevents",
      "ref-napi",
      "ffi-napi"
    ];

    for (const forbidden of forbiddenNativePackages) {
      expect(allDeps).not.toHaveProperty(forbidden);
    }
  });

  it("verifies bin/omo-codeg and bin/omo-codeg.ts executable files exist with shebangs", () => {
    const binJsPath = resolve(pkgRoot, "bin/omo-codeg");
    const binTsPath = resolve(pkgRoot, "bin/omo-codeg.ts");

    expect(existsSync(binJsPath)).toBe(true);
    expect(existsSync(binTsPath)).toBe(true);

    const jsContent = readFileSync(binJsPath, "utf-8");
    const tsContent = readFileSync(binTsPath, "utf-8");

    expect(jsContent.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(tsContent.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("verifies tsconfig.json and tsconfig.build.json configuration", () => {
    const tsconfigPath = resolve(pkgRoot, "tsconfig.json");
    const tsconfigBuildPath = resolve(pkgRoot, "tsconfig.build.json");

    expect(existsSync(tsconfigPath)).toBe(true);
    expect(existsSync(tsconfigBuildPath)).toBe(true);

    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    const tsconfigBuild = JSON.parse(readFileSync(tsconfigBuildPath, "utf-8"));

    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
    expect(tsconfig.compilerOptions.moduleResolution).toBe("NodeNext");
    expect(tsconfigBuild.extends).toBe("./tsconfig.json");
    expect(tsconfigBuild.exclude).toContain("tests/**/*");
  });

  it("verifies src/index.ts exports opencodeCodegBridgePlugin and runCli", () => {
    expect(typeof opencodeCodegBridgePlugin).toBe("function");
    expect(typeof runCli).toBe("function");
  });
});
