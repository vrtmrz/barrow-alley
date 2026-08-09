import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist-web",
    "main.js",
    "esbuild.config.mjs",
    "scripts",
    "test",
    "vitest.config.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.test.json",
    "versions.json",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "manifest.json"],
        },
        extraFileExtensions: [".json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/compat-global.ts"],
    rules: {
      // This module is the one reviewed browser/Node compatibility workaround.
      "obsidianmd/no-global-this": "off",
    },
  },
  {
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Barrow Alley"],
          enforceCamelCaseLower: true,
          ignoreRegex: ["^Pitch No\\.$"],
        },
      ],
    },
  },
);
