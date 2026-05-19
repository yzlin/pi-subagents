import { describe, expect, it } from "vitest";

import {
  createReleasePlan,
  createTagLink,
  extractReleaseNotes,
  extractUnreleasedNotes,
  foldUnreleasedNotesIntoRelease,
  inferBumpFromReleaseNotes,
} from "../src/release-plan";

const missingUnreleasedPattern = /missing an \[Unreleased\]/;
const emptyUnreleasedPattern = /empty/;
const malformedEntryPattern = /heading has no entries: Added/;

const baseChangelog = `# Changelog

## [Unreleased]

### Added
- New release planner.

### Fixed
- Stable release notes extraction.

## [0.1.0] - 2026-01-01

### Added
- First release.
`;

describe("release planning", () => {
  it("extracts exact release notes from [Unreleased]", () => {
    expect(extractUnreleasedNotes(baseChangelog)).toBe(
      `### Added
- New release planner.

### Fixed
- Stable release notes extraction.`
    );
  });

  it("fails when [Unreleased] is missing", () => {
    expect(() => extractUnreleasedNotes("# Changelog\n")).toThrow(
      missingUnreleasedPattern
    );
  });

  it("fails when [Unreleased] is empty", () => {
    expect(() =>
      extractUnreleasedNotes(
        "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n"
      )
    ).toThrow(emptyUnreleasedPattern);
  });

  it("fails when [Unreleased] entries are malformed", () => {
    expect(() =>
      extractUnreleasedNotes(
        "# Changelog\n\n## [Unreleased]\n\n### Added\nNothing here\n"
      )
    ).toThrow(malformedEntryPattern);
  });

  it("infers major intent from Breaking after 1.0", () => {
    expect(
      inferBumpFromReleaseNotes("### Breaking\n- Remove old API.", "1.2.3")
    ).toBe("major");
  });

  it("infers minor intent from Breaking before 1.0", () => {
    expect(
      inferBumpFromReleaseNotes("### Breaking\n- Remove old API.", "0.2.3")
    ).toBe("minor");
  });

  it("infers minor intent from feature headings", () => {
    expect(
      inferBumpFromReleaseNotes(
        "### Changed\n- Adjust behavior.\n\n### Fixed\n- Fix bug."
      )
    ).toBe("minor");
  });

  it("infers patch intent when only Fixed and Security are present", () => {
    expect(
      inferBumpFromReleaseNotes(
        "### Security\n- Harden input.\n\n### Fixed\n- Fix bug."
      )
    ).toBe("patch");
  });

  it("supports bump override while preserving inferred bump", () => {
    const plan = createReleasePlan({
      bumpOverride: "patch",
      changelog: baseChangelog,
      releaseDate: "2026-05-19",
      repositoryUrl: "https://github.com/yzlin/pi-subagents",
      version: "0.2.0",
    });

    expect(plan.bump).toBe("patch");
    expect(plan.inferredBump).toBe("minor");
  });

  it("updates changelog with a fresh empty [Unreleased] and released content", () => {
    const plan = createReleasePlan({
      changelog: baseChangelog,
      previousVersion: "0.1.0",
      releaseDate: "2026-05-19",
      repositoryUrl: "https://github.com/yzlin/pi-subagents",
      version: "0.2.0",
    });

    expect(plan.updatedChangelog).toContain(
      `## [Unreleased]

## [0.2.0] - 2026-05-19

### Added
- New release planner.`
    );
    expect(plan.updatedChangelog).toContain(
      "[0.2.0]: https://github.com/yzlin/pi-subagents/compare/v0.1.0...v0.2.0"
    );
  });

  it("extracts exact notes for a released version", () => {
    expect(extractReleaseNotes(baseChangelog, "0.1.0")).toBe(`### Added
- First release.`);
  });

  it("folds unreleased notes into an existing release section", () => {
    const folded = foldUnreleasedNotesIntoRelease(baseChangelog, "0.1.0");

    expect(() => extractUnreleasedNotes(folded)).toThrow(
      emptyUnreleasedPattern
    );
    expect(folded).toContain("## [Unreleased]\n\n## [0.1.0] - 2026-01-01");
    expect(extractReleaseNotes(folded, "0.1.0")).toBe(`### Added
- New release planner.

### Fixed
- Stable release notes extraction.

### Added
- First release.`);
  });

  it("generates first-fork tag links and later compare links", () => {
    expect(
      createTagLink("https://github.com/yzlin/pi-subagents.git", "0.1.0")
    ).toBe(
      "[0.1.0]: https://github.com/yzlin/pi-subagents/releases/tag/v0.1.0"
    );
    expect(
      createTagLink("https://github.com/yzlin/pi-subagents", "0.2.0", "0.1.0")
    ).toBe(
      "[0.2.0]: https://github.com/yzlin/pi-subagents/compare/v0.1.0...v0.2.0"
    );
  });
});
