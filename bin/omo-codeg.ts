#!/usr/bin/env node
import { runCli } from "../src/index.js";

runCli().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
