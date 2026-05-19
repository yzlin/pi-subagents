export interface PackFile {
  path: string;
}

export interface PackResult {
  files?: PackFile[];
}

const requiredPackageFiles = new Set([
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
]);

const distRuntimeOrTypeFilePattern = /^dist\/.+\.(?:js|d\.ts)$/;

const forbiddenPathPatterns = [
  /^src\//,
  /^test\//,
  /^tests\//,
  /^scripts\//,
  /^\.github\//,
  /^\.pi\//,
  /^\.husky\//,
  /^media\//,
  /(^|\/)__tests__\//,
  /(^|\/)\.DS_Store$/,
  /(^|\/)tsconfig\.json$/,
  /(^|\/)biome\.jsonc$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)bun\.lock$/,
  /(^|\/)\.npmignore$/,
  /(^|\/)\.gitignore$/,
  /(^|\/).+\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/).+\.(png|jpe?g|gif|webp|svg|mp4|mov|webm)$/i,
];

function isAllowedPackageFile(path: string): boolean {
  return (
    requiredPackageFiles.has(path) || distRuntimeOrTypeFilePattern.test(path)
  );
}

export function validatePackageFiles(packResult: PackResult): string[] {
  const files = packResult.files?.map((file) => file.path).sort() ?? [];
  const errors: string[] = [];

  for (const requiredFile of requiredPackageFiles) {
    if (!files.includes(requiredFile)) {
      errors.push(`Missing required package file: ${requiredFile}`);
    }
  }

  for (const file of files) {
    if (!isAllowedPackageFile(file)) {
      errors.push(`Disallowed package file: ${file}`);
      continue;
    }

    if (forbiddenPathPatterns.some((pattern) => pattern.test(file))) {
      errors.push(`Forbidden package file leak: ${file}`);
    }
  }

  return errors;
}
