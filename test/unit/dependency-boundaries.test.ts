import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { findDependencyBoundaryViolations } from "../../scripts/dependency-boundaries.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRepositories: string[] = [];

async function createFixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "barrow-alley-boundaries-"));
  temporaryRepositories.push(root);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );

  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("dependency boundaries", () => {
  it("keeps the repository within its permitted dependencies", () => {
    expect(findDependencyBoundaryViolations(repositoryRoot)).toEqual([]);
  });

  it("rejects host adapters imported by the neutral core", async () => {
    const fixture = await createFixture({
      "src/core/example.ts": [
        'import type { App } from "obsidian";',
        'import { createBrowserUi } from "@vrtmrz/browser-ui-kit";',
      ].join("\n"),
    });

    expect(findDependencyBoundaryViolations(fixture)).toEqual([
      {
        code: "CORE_HOST_DEPENDENCY",
        importer: "src/core/example.ts",
        specifier: "obsidian",
        target: undefined,
      },
      {
        code: "CORE_HOST_DEPENDENCY",
        importer: "src/core/example.ts",
        specifier: "@vrtmrz/browser-ui-kit",
        target: undefined,
      },
    ]);
  });

  it("rejects direct and transitive Obsidian dependencies from the web harness", async () => {
    const fixture = await createFixture({
      "src/obsidian/plugin.ts": 'import { Plugin } from "obsidian";',
      "src/shared.ts": 'export * from "./obsidian/plugin.js";',
      "test/web/src/direct.ts":
        'import { createObsidianUi } from "@vrtmrz/obsidian-plugin-kit/ui";',
      "test/web/src/transitive.svelte":
        '<script lang="ts">import "@barrow-alley/shared.js";</script>',
    });

    expect(findDependencyBoundaryViolations(fixture)).toEqual([
      {
        code: "WEB_OBSIDIAN_DEPENDENCY",
        importer: "test/web/src/direct.ts",
        specifier: "@vrtmrz/obsidian-plugin-kit/ui",
        target: undefined,
      },
      {
        code: "WEB_OBSIDIAN_DEPENDENCY",
        importer: "src/shared.ts",
        specifier: "./obsidian/plugin.js",
        target: "src/obsidian/plugin.ts",
      },
      {
        code: "WEB_OBSIDIAN_DEPENDENCY",
        importer: "src/obsidian/plugin.ts",
        specifier: "obsidian",
        target: undefined,
      },
    ]);
  });
});
