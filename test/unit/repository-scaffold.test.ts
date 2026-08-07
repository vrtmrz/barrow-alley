import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const value = await readFile(`${repositoryRoot}/${relativePath}`, "utf8");
  return JSON.parse(value) as Record<string, unknown>;
}

async function findPackageManifests(directory = repositoryRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = await Promise.all(
    entries.map(async (entry) => {
      if ([".git", "dist-web", "node_modules"].includes(entry.name)) {
        return [];
      }

      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return findPackageManifests(target);
      }

      return entry.name === "package.json"
        ? [path.relative(repositoryRoot, target).replaceAll(path.sep, "/")]
        : [];
    }),
  );

  return manifests.flat();
}

describe("repository scaffold", () => {
  it("keeps release metadata aligned", async () => {
    const [manifest, packageJson, versions] = await Promise.all([
      readJson("manifest.json"),
      readJson("package.json"),
      readJson("versions.json"),
    ]);

    expect(packageJson.version).toBe(manifest.version);
    expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
    expect(packageJson.name).toBe("barrow-alley");
    expect(manifest.id).toBe("barrow-alley");
    expect(manifest.name).toBe("Barrow Alley");
  });

  it("uses one root npm package without workspaces", async () => {
    const packageJson = await readJson("package.json");
    expect(packageJson).not.toHaveProperty("workspaces");
    await expect(findPackageManifests()).resolves.toEqual(["package.json"]);
    await expect(access(`${repositoryRoot}/package-lock.json`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/test/web/package.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
