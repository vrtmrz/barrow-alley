import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const preparationScript = path.join(
    repositoryRoot,
    "scripts/prepare-plugin-release.mjs",
);

interface ReleaseFixtureOptions {
    readonly packageVersion?: string;
}

async function createReleaseFixture(
    options: ReleaseFixtureOptions = {},
): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "barrow-alley-release-"));
    const manifest = {
        id: "barrow-alley",
        name: "Barrow Alley",
        version: "0.1.0",
        minAppVersion: "1.8.7",
    };

    await Promise.all([
        writeFile(path.join(root, "main.js"), "plugin bundle\n", "utf8"),
        writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), "utf8"),
        writeFile(
            path.join(root, "package.json"),
            JSON.stringify({
                name: "barrow-alley",
                version: options.packageVersion ?? manifest.version,
            }),
            "utf8",
        ),
        writeFile(path.join(root, "styles.css"), "/* plug-in styles */\n", "utf8"),
        writeFile(
            path.join(root, "versions.json"),
            JSON.stringify({ [manifest.version]: manifest.minAppVersion }),
            "utf8",
        ),
    ]);

    return root;
}

describe("release preparation", () => {
    it("stages only the required Obsidian plug-in assets", async () => {
        const fixtureRoot = await createReleaseFixture();

        await execFileAsync(process.execPath, [preparationScript], {
            cwd: fixtureRoot,
        });

        const releaseDirectory = path.join(fixtureRoot, "build/release");
        await expect(readdir(releaseDirectory)).resolves.toEqual([
            "main.js",
            "manifest.json",
            "styles.css",
        ]);
        await expect(
            readFile(path.join(releaseDirectory, "main.js"), "utf8"),
        ).resolves.toBe("plugin bundle\n");
    });

    it("rejects inconsistent release versions", async () => {
        const fixtureRoot = await createReleaseFixture({ packageVersion: "0.1.1" });

        await expect(
            execFileAsync(process.execPath, [preparationScript], {
                cwd: fixtureRoot,
            }),
        ).rejects.toThrow(/package\.json version/);
    });

    it("keeps the hosted workflow non-publishing and plug-in-only", async () => {
        const workflow = await readFile(
            path.join(repositoryRoot, ".github/workflows/prepare-release.yml"),
            "utf8",
        );

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).toContain("contents: read");
        expect(workflow).toContain("uses: actions/upload-artifact@v4");
        expect(workflow).toContain("build/release/main.js");
        expect(workflow).toContain("build/release/manifest.json");
        expect(workflow).toContain("build/release/styles.css");
        expect(workflow).not.toContain("dist-web");
        expect(workflow).not.toContain("contents: write");
        expect(workflow).not.toContain("gh release");
        expect(workflow).not.toContain("tags:");
    });
});
