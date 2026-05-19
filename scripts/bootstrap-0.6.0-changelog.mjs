#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const dryRun = !args.has("--yes");
const version = "0.6.0";

const run = async () => {
  const { extractReleaseNotes, foldUnreleasedNotesIntoRelease } = await import(
    "../dist/release-plan.js"
  ).catch((error) => {
    throw new Error(
      "Build release helpers first with `npm run build` before running the 0.6.0 changelog bootstrap.",
      { cause: error }
    );
  });
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const updatedChangelog = foldUnreleasedNotesIntoRelease(changelog, version);
  const releaseNotes = extractReleaseNotes(updatedChangelog, version);

  console.error(
    dryRun
      ? `[dry-run] Would fold CHANGELOG.md [Unreleased] into [${version}]`
      : `Folding CHANGELOG.md [Unreleased] into [${version}]`
  );
  console.error(`Release notes for v${version}:\n\n${releaseNotes}`);

  if (!dryRun) {
    writeFileSync("CHANGELOG.md", updatedChangelog);
  }
};

await run();
