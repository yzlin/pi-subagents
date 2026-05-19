export type ReleaseBump = "major" | "minor" | "patch";

export interface ReleasePlanOptions {
  changelog: string;
  version: string;
  releaseDate: string;
  repositoryUrl: string;
  previousVersion?: string;
  bumpOverride?: ReleaseBump;
  currentVersion?: string;
}

export interface ReleasePlan {
  version: string;
  bump: ReleaseBump;
  inferredBump: ReleaseBump;
  releaseNotes: string;
  updatedChangelog: string;
  tagLink: string;
}

const MINOR_HEADINGS = new Set(["Added", "Changed", "Deprecated", "Removed"]);
const PATCH_HEADINGS = new Set(["Fixed", "Security"]);
const ALLOWED_HEADINGS = new Set([
  "Breaking",
  ...MINOR_HEADINGS,
  ...PATCH_HEADINGS,
]);
const UNRELEASED_HEADING_PATTERN = /^## \[Unreleased\][^\n]*(?:\n|$)/m;
const RELEASE_HEADING_PATTERN = /^## /m;
const RELEASE_NOTE_HEADING_PATTERN = /^###\s+(.+)\s*$/gm;
const RELEASE_NOTE_HEADING_START_PATTERN = /^###\s+/m;
const CHANGELOG_UNRELEASED_SECTION_PATTERN =
  /^## \[Unreleased\][^\n]*(?:\n|$)[\s\S]*?(?=^## |$(?![\s\S]))/m;
const BULLET_ENTRY_PATTERN = /^\s*-\s+\S/m;
const GIT_SUFFIX_PATTERN = /\.git$/;
const TRAILING_SLASH_PATTERN = /\/$/;
const VERSION_PREFIX_PATTERN = /^v/;
const LEADING_NEWLINES_PATTERN = /^\n+/;

export function createReleasePlan(options: ReleasePlanOptions): ReleasePlan {
  const releaseNotes = extractUnreleasedNotes(options.changelog);
  const inferredBump = inferBumpFromReleaseNotes(
    releaseNotes,
    options.currentVersion
  );
  const bump = options.bumpOverride ?? inferredBump;
  const tagLink = createTagLink(
    options.repositoryUrl,
    options.version,
    options.previousVersion
  );
  const updatedChangelog = updateChangelog({
    changelog: options.changelog,
    releaseDate: options.releaseDate,
    releaseNotes,
    tagLink,
    version: options.version,
  });

  return {
    bump,
    inferredBump,
    releaseNotes,
    tagLink,
    updatedChangelog,
    version: options.version,
  };
}

export function extractUnreleasedNotes(changelog: string): string {
  const match = changelog.match(UNRELEASED_HEADING_PATTERN);
  if (match?.index === undefined) {
    throw new Error("CHANGELOG.md is missing an [Unreleased] section");
  }

  const start = match.index + match[0].length;
  const nextReleaseIndex = changelog
    .slice(start)
    .search(RELEASE_HEADING_PATTERN);
  const end =
    nextReleaseIndex === -1 ? changelog.length : start + nextReleaseIndex;
  const notes = changelog.slice(start, end).trim();

  validateReleaseNotes(notes);

  return notes;
}

export function inferBumpFromReleaseNotes(
  notes: string,
  currentVersion = "1.0.0"
): ReleaseBump {
  const headings = Array.from(
    notes.matchAll(RELEASE_NOTE_HEADING_PATTERN),
    (match) => match[1].trim()
  );

  if (headings.includes("Breaking")) {
    return isPreOne(currentVersion) ? "minor" : "major";
  }

  if (headings.some((heading) => MINOR_HEADINGS.has(heading))) {
    return "minor";
  }

  return "patch";
}

export function extractReleaseNotes(
  changelog: string,
  version: string
): string {
  const section = findReleaseSection(changelog, version);

  return changelog.slice(section.bodyStart, section.bodyEnd).trim();
}

export function foldUnreleasedNotesIntoRelease(
  changelog: string,
  version: string
): string {
  const releaseNotes = extractUnreleasedNotes(changelog);
  const releaseSection = findReleaseSection(changelog, version);
  const existingReleaseNotes = changelog
    .slice(releaseSection.bodyStart, releaseSection.bodyEnd)
    .trim();
  const foldedReleaseNotes = existingReleaseNotes
    ? `${releaseNotes}\n\n${existingReleaseNotes}`
    : releaseNotes;
  const withoutUnreleasedNotes = changelog.replace(
    CHANGELOG_UNRELEASED_SECTION_PATTERN,
    "## [Unreleased]\n\n"
  );
  const adjustedReleaseSection = findReleaseSection(
    withoutUnreleasedNotes,
    version
  );
  const beforeReleaseNotes = withoutUnreleasedNotes.slice(
    0,
    adjustedReleaseSection.bodyStart
  );
  const afterReleaseNotes = withoutUnreleasedNotes.slice(
    adjustedReleaseSection.bodyEnd
  );

  return `${beforeReleaseNotes}${foldedReleaseNotes}\n\n${afterReleaseNotes.replace(LEADING_NEWLINES_PATTERN, "")}`;
}

export function createTagLink(
  repositoryUrl: string,
  version: string,
  previousVersion?: string
): string {
  const repo = repositoryUrl
    .replace(GIT_SUFFIX_PATTERN, "")
    .replace(TRAILING_SLASH_PATTERN, "");
  const tag = formatTag(version);

  if (!previousVersion) {
    return `[${version}]: ${repo}/releases/tag/${tag}`;
  }

  return `[${version}]: ${repo}/compare/${formatTag(previousVersion)}...${tag}`;
}

function findReleaseSection(
  changelog: string,
  version: string
): { bodyEnd: number; bodyStart: number } {
  const headingPattern = new RegExp(
    `^## \\[${escapeRegExp(version.replace(VERSION_PREFIX_PATTERN, ""))}\\][^\\n]*(?:\\n|$)`,
    "m"
  );
  const match = changelog.match(headingPattern);
  if (match?.index === undefined) {
    throw new Error(`CHANGELOG.md is missing a section for ${version}`);
  }

  const bodyStart = match.index + match[0].length;
  const nextReleaseIndex = changelog
    .slice(bodyStart)
    .search(RELEASE_HEADING_PATTERN);
  const bodyEnd =
    nextReleaseIndex === -1 ? changelog.length : bodyStart + nextReleaseIndex;

  return { bodyEnd, bodyStart };
}

function updateChangelog(options: {
  changelog: string;
  releaseDate: string;
  releaseNotes: string;
  tagLink: string;
  version: string;
}): string {
  const releaseHeading = `## [${options.version}] - ${options.releaseDate}`;
  const replacement = `## [Unreleased]\n\n${releaseHeading}\n\n${options.releaseNotes}\n`;
  const updated = options.changelog.replace(
    CHANGELOG_UNRELEASED_SECTION_PATTERN,
    replacement
  );

  const linkWithTrailingNewline = `${options.tagLink}\n`;
  return updated.endsWith("\n")
    ? `${updated}${linkWithTrailingNewline}`
    : `${updated}\n${linkWithTrailingNewline}`;
}

function validateReleaseNotes(notes: string): void {
  if (!notes) {
    throw new Error("CHANGELOG.md [Unreleased] section is empty");
  }

  const headings = Array.from(
    notes.matchAll(RELEASE_NOTE_HEADING_PATTERN),
    (match) => match[1].trim()
  );
  if (headings.length === 0) {
    throw new Error("CHANGELOG.md [Unreleased] section has no change headings");
  }

  for (const heading of headings) {
    if (!ALLOWED_HEADINGS.has(heading)) {
      throw new Error(
        `CHANGELOG.md [Unreleased] contains unsupported heading: ${heading}`
      );
    }
  }

  for (const heading of headings) {
    const headingMatch = new RegExp(
      `^###\\s+${escapeRegExp(heading)}\\s*$`,
      "m"
    ).exec(notes);
    if (!headingMatch) {
      continue;
    }
    const start = headingMatch.index + headingMatch[0].length;
    const nextHeadingIndex = notes
      .slice(start)
      .search(RELEASE_NOTE_HEADING_START_PATTERN);
    const end =
      nextHeadingIndex === -1 ? notes.length : start + nextHeadingIndex;
    const body = notes.slice(start, end);
    if (!BULLET_ENTRY_PATTERN.test(body)) {
      throw new Error(
        `CHANGELOG.md [Unreleased] heading has no entries: ${heading}`
      );
    }
  }
}

function isPreOne(version: string): boolean {
  return version.replace(VERSION_PREFIX_PATTERN, "").startsWith("0.");
}

function formatTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
