#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = new Set(process.argv.slice(2));
const getArg = (name) => {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const dryRun = !args.has("--yes");
const bumpOverride = getArg("--bump");
const allowedBumps = new Set(["major", "minor", "patch"]);

if (bumpOverride && !allowedBumps.has(bumpOverride)) {
  throw new Error("--bump must be major, minor, or patch");
}

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
const today = () => new Date().toISOString().slice(0, 10);
const bumpVersion = (version, bump) => {
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  if ([major, minor, patch].some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid package version: ${version}`);
  }
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
};

run("npm", ["run", "build"]);
const { createReleasePlan } = await import("../dist/release-plan.js");

const packageJson = readJson("package.json");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const repositoryUrl = packageJson.repository?.url?.replace(/^git\+/, "");
if (!repositoryUrl) {
  throw new Error("package.json repository.url is required");
}

const probePlan = createReleasePlan({
  bumpOverride,
  changelog,
  currentVersion: packageJson.version,
  releaseDate: today(),
  repositoryUrl,
  version: packageJson.version,
});
const nextVersion = bumpVersion(packageJson.version, probePlan.bump);
const plan = createReleasePlan({
  bumpOverride,
  changelog,
  currentVersion: packageJson.version,
  previousVersion: packageJson.version,
  releaseDate: today(),
  repositoryUrl,
  version: nextVersion,
});
const tag = formatTag(nextVersion);
const currentBranch = run("git", ["branch", "--show-current"], { capture: true }).trim();
if (currentBranch !== "main") {
  const message = `Release prepare must run on main; current branch is ${currentBranch || "detached HEAD"}`;
  if (!dryRun) {
    throw new Error(message);
  }
  console.error(`[dry-run] ${message}`);
}

console.error(`Preparing ${packageJson.name} ${nextVersion} (${plan.bump}; inferred ${plan.inferredBump})`);

run("npm", ["version", nextVersion, "--no-git-tag-version"], { mutates: true });
if (!dryRun) {
  writeFileSync("CHANGELOG.md", plan.updatedChangelog);
} else {
  console.error("[dry-run] update CHANGELOG.md");
}
run("npm", ["run", "release:gate"]);
run("git", ["diff", "--", "package.json", "package-lock.json", "CHANGELOG.md"]);
run("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"], { mutates: true });
run("git", ["commit", "-m", `chore: release ${tag}`], { mutates: true });
run("git", ["tag", "-a", tag, "-m", tag], { mutates: true });
run("git", ["push", "--atomic", "origin", "main", tag], { mutates: true });
run("gh", ["workflow", "run", "npm-publish.yml", "--ref", tag], { mutates: true });

console.error(dryRun ? `Dry run complete for ${tag}. Re-run with --yes to commit, tag, push, and dispatch.` : `Release prepared and dispatched for ${tag}.`);
