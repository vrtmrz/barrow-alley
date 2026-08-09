import {
    appendFile,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rm,
    stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const EXPECTED_ASSETS = ["main.js", "manifest.json", "styles.css"];

/**
 * Reads repository metadata as a JSON object and rejects values which cannot
 * participate in the release consistency checks.
 *
 * @param {string} filePath Absolute path to the JSON file.
 * @returns {Promise<Record<string, unknown>>} Parsed metadata.
 */
async function readJsonObject(filePath) {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path.basename(filePath)} must contain a JSON object.`);
    }

    return value;
}

/**
 * Prevents metadata drift from producing an installable-looking but invalid
 * release candidate.
 *
 * @param {Record<string, unknown>} manifest Obsidian manifest metadata.
 * @param {Record<string, unknown>} packageJson npm package metadata.
 * @param {Record<string, unknown>} versions Obsidian version compatibility map.
 */
function validateMetadata(manifest, packageJson, versions) {
    if (manifest.id !== "barrow-alley") {
        throw new Error("manifest.json id must be barrow-alley.");
    }
    if (manifest.name !== "Barrow Alley") {
        throw new Error("manifest.json name must be Barrow Alley.");
    }
    if (packageJson.name !== manifest.id) {
        throw new Error("package.json name must match manifest.json id.");
    }
    if (packageJson.version !== manifest.version) {
        throw new Error("package.json version must match manifest.json version.");
    }
    if (
        typeof manifest.version !== "string" ||
        typeof manifest.minAppVersion !== "string"
    ) {
        throw new Error(
            "manifest.json version and minAppVersion must both be strings.",
        );
    }
    if (versions[manifest.version] !== manifest.minAppVersion) {
        throw new Error(
            "versions.json must map the release version to manifest.json minAppVersion.",
        );
    }
}

/**
 * Stages exactly the files accepted as an Obsidian plug-in release. The fixed
 * directory also keeps browser output outside the packaging boundary.
 *
 * @param {string} repositoryRoot Repository containing the built plug-in.
 * @returns {Promise<{directory: string, version: string}>} Prepared result.
 */
async function prepareRelease(repositoryRoot) {
    const releaseDirectory = path.join(repositoryRoot, "build", "release");
    const [manifest, packageJson, versions] = await Promise.all([
        readJsonObject(path.join(repositoryRoot, "manifest.json")),
        readJsonObject(path.join(repositoryRoot, "package.json")),
        readJsonObject(path.join(repositoryRoot, "versions.json")),
    ]);

    validateMetadata(manifest, packageJson, versions);

    await Promise.all(
        EXPECTED_ASSETS.map(async (asset) => {
            const source = path.join(repositoryRoot, asset);
            const sourceStat = await stat(source);
            if (!sourceStat.isFile()) {
                throw new Error(`${asset} must be a regular file.`);
            }
        }),
    );

    await rm(releaseDirectory, { force: true, recursive: true });
    await mkdir(releaseDirectory, { recursive: true });
    await Promise.all(
        EXPECTED_ASSETS.map((asset) =>
            copyFile(
                path.join(repositoryRoot, asset),
                path.join(releaseDirectory, asset),
            ),
        ),
    );

    const stagedAssets = (await readdir(releaseDirectory)).sort();
    if (stagedAssets.join("\n") !== [...EXPECTED_ASSETS].sort().join("\n")) {
        throw new Error("The prepared release contains unexpected files.");
    }

    return {
        directory: releaseDirectory,
        version: manifest.version,
    };
}

const repositoryRoot = path.resolve(process.cwd());
const result = await prepareRelease(repositoryRoot);

if (process.env.GITHUB_OUTPUT !== undefined) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\n`, "utf8");
}

console.log(
    `Prepared Barrow Alley ${result.version} with ${EXPECTED_ASSETS.join(", ")} in ${path.relative(repositoryRoot, result.directory)}.`,
);
