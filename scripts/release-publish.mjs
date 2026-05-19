#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const args = new Set(process.argv.slice(2));
const dryRun = !args.has("--yes");

const run = (command, commandArgs, options = {}) => {
  const printable = [command, ...commandArgs].join(" ");
  if (dryRun && options.mutates) {
    console.error(`[dry-run] ${printable}`);
    return "";
  }
  console.error(`$ ${printable}`);
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const formatTag = (version) => `v${version.replace(/^v/, "")}`;

const packageJson = readJson("package.json");
const expectedTag = formatTag(packageJson.version);
const currentRef = process.env.GITHUB_REF_NAME || run("git", ["describe", "--tags", "--exact-match"], { capture: true }).trim();

if (currentRef !== expectedTag) {
  throw new Error(`Current ref ${currentRef} does not match package version tag ${expectedTag}`);
}

const packageLock = readJson("package-lock.json");
if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  throw new Error("package-lock.json version does not match package.json");
}

run("npm", ["run", "release:gate"]);
const { extractReleaseNotes } = await import("../dist/release-plan.js");

let publishedVersion = "";
try {
  publishedVersion = run("npm", ["view", `${packageJson.name}@${packageJson.version}`, "version"], { capture: true }).trim();
} catch {
  publishedVersion = "";
}

const releaseNotes = extractReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), packageJson.version);
const releaseNotesPath = join(mkdtempSync(join(tmpdir(), "pi-subagents-release-")), "notes.md");
writeFileSync(releaseNotesPath, releaseNotes);

if (publishedVersion === packageJson.version) {
  console.error(`${packageJson.name}@${packageJson.version} already exists on npm; skipping publish.`);
} else {
  run("npm", ["publish", "--provenance", "--access", "public", "--tag", "latest"], { mutates: true });
}

const releaseExists = (() => {
  try {
    run("gh", ["release", "view", expectedTag], { capture: true });
    return true;
  } catch {
    return false;
  }
})();

if (releaseExists) {
  run("gh", ["release", "edit", expectedTag, "--title", expectedTag, "--notes-file", releaseNotesPath], { mutates: true });
} else {
  run("gh", ["release", "create", expectedTag, "--title", expectedTag, "--notes-file", releaseNotesPath], { mutates: true });
}

console.error(dryRun ? `Dry run complete for ${expectedTag}. Re-run with --yes to publish and update GitHub Release.` : `Publish helper complete for ${expectedTag}.`);
