import { describe, expect, it } from "vitest";

import { validatePackageFiles } from "../src/package-validation";

const validFiles = [
  { path: "package.json" },
  { path: "README.md" },
  { path: "CHANGELOG.md" },
  { path: "LICENSE" },
  { path: "dist/index.js" },
  { path: "dist/index.d.ts" },
];

describe("package validation", () => {
  it("accepts the minimal package whitelist", () => {
    expect(validatePackageFiles({ files: validFiles })).toEqual([]);
  });

  it("rejects source, test, config, workflow, and media leaks", () => {
    expect(
      validatePackageFiles({
        files: [
          ...validFiles,
          { path: "src/index.ts" },
          { path: "test/index.test.ts" },
          { path: "biome.jsonc" },
          { path: ".github/workflows/release.yml" },
          { path: "media/demo.mp4" },
        ],
      })
    ).toEqual([
      "Disallowed package file: .github/workflows/release.yml",
      "Disallowed package file: biome.jsonc",
      "Disallowed package file: media/demo.mp4",
      "Disallowed package file: src/index.ts",
      "Disallowed package file: test/index.test.ts",
    ]);
  });

  it("requires npm metadata docs", () => {
    expect(
      validatePackageFiles({
        files: [{ path: "package.json" }, { path: "dist/index.js" }],
      })
    ).toEqual([
      "Missing required package file: README.md",
      "Missing required package file: CHANGELOG.md",
      "Missing required package file: LICENSE",
    ]);
  });
});
