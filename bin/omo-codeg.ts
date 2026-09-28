#!/usr/bin/env node
import { runCli } from "../src/index.js";

runCli().catch((err: unknown) => {
  if (process.argv.includes("--json")) {
    const errorPayload = {
      success: false,
      error: {
        name: err instanceof Error ? err.name : "Error",
        code: (err as any)?.code || "ERR_CLI",
        message: err instanceof Error ? err.message : String(err),
        remediation: (err as any)?.remediation,
        details: (err as any)?.details
      },
      timestamp: new Date().toISOString()
    };
    console.log(JSON.stringify(errorPayload, null, 2));
  } else {
    console.error(err);
  }
  process.exit(1);
});
