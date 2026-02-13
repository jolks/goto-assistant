#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

if (!process.env.GOTO_DATA_DIR) {
  process.env.GOTO_DATA_DIR = join(homedir(), ".goto-assistant");
}

await import("../dist/index.js");
