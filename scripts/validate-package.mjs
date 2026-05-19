#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { validatePackageFiles } from "../dist/package-validation.js";

const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
  encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }
);

const [packResult] = JSON.parse(output);
const errors = validatePackageFiles(packResult);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}
