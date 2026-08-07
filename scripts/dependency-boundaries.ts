import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".svelte"] as const;

interface Dependency {
  readonly specifier: string;
  readonly resolvedPath: string | undefined;
}

export interface BoundaryViolation {
  readonly code: "CORE_HOST_DEPENDENCY" | "WEB_OBSIDIAN_DEPENDENCY";
  readonly importer: string;
  readonly specifier: string;
  readonly target: string | undefined;
}

function normalisePath(path: string): string {
  return path.split(sep).join("/");
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
    } else if (SOURCE_EXTENSIONS.includes(extname(path) as (typeof SOURCE_EXTENSIONS)[number])) {
      files.push(path);
    }
  }
  return files;
}

function extractSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const staticImport = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s*)?["']([^"']+)["']/gu;
  const dynamicImport = /import\s*\(\s*["']([^"']+)["']\s*\)/gu;

  for (const match of source.matchAll(staticImport)) {
    if (match[1] !== undefined) specifiers.add(match[1]);
  }
  for (const match of source.matchAll(dynamicImport)) {
    if (match[1] !== undefined) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveLocalImport(root: string, importer: string, specifier: string): string | undefined {
  let unresolved: string;
  if (specifier.startsWith(".")) {
    unresolved = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith("@barrow-alley/")) {
    unresolved = resolve(root, "src", specifier.slice("@barrow-alley/".length));
  } else {
    return undefined;
  }

  const candidates = [unresolved];
  const extension = extname(unresolved);
  if (extension === ".js" || extension === ".mjs") {
    candidates.push(unresolved.slice(0, -extension.length) + ".ts");
  }
  for (const sourceExtension of SOURCE_EXTENSIONS) {
    candidates.push(`${unresolved}${sourceExtension}`);
    candidates.push(resolve(unresolved, `index${sourceExtension}`));
  }

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function isPackage(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isWithin(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child === "" || (!child.startsWith("..") && !child.startsWith(sep));
}

function isObsidianLocalTarget(root: string, path: string): boolean {
  return path === resolve(root, "src/main.ts") || isWithin(path, resolve(root, "src/obsidian"));
}

/** Returns dependency violations for the host-neutral core and browser harness. */
export function findDependencyBoundaryViolations(root: string): BoundaryViolation[] {
  const sourceFiles = [...walk(resolve(root, "src")), ...walk(resolve(root, "test/web"))];
  const graph = new Map<string, Dependency[]>();

  for (const sourceFile of sourceFiles) {
    const dependencies = extractSpecifiers(readFileSync(sourceFile, "utf8")).map((specifier) => ({
      specifier,
      resolvedPath: resolveLocalImport(root, sourceFile, specifier),
    }));
    graph.set(sourceFile, dependencies);
  }

  const violations: BoundaryViolation[] = [];
  const coreRoot = resolve(root, "src/core");
  const forbiddenCorePackages = [
    "obsidian",
    "svelte",
    "@sveltejs/vite-plugin-svelte",
    "@vrtmrz/browser-ui-kit",
    "@vrtmrz/obsidian-plugin-kit",
  ];

  for (const [importer, dependencies] of graph) {
    if (!isWithin(importer, coreRoot)) continue;
    for (const dependency of dependencies) {
      const forbiddenPackage = forbiddenCorePackages.some((packageName) =>
        isPackage(dependency.specifier, packageName),
      );
      const forbiddenLocalTarget =
        dependency.resolvedPath !== undefined &&
        (isObsidianLocalTarget(root, dependency.resolvedPath) ||
          isWithin(dependency.resolvedPath, resolve(root, "test/web")));
      if (forbiddenPackage || forbiddenLocalTarget) {
        violations.push({
          code: "CORE_HOST_DEPENDENCY",
          importer: normalisePath(relative(root, importer)),
          specifier: dependency.specifier,
          target:
            dependency.resolvedPath === undefined
              ? undefined
              : normalisePath(relative(root, dependency.resolvedPath)),
        });
      }
    }
  }

  const queue = walk(resolve(root, "test/web"));
  const visited = new Set<string>();
  const forbiddenWebPackages = ["obsidian", "@vrtmrz/obsidian-plugin-kit"];
  while (queue.length > 0) {
    const importer = queue.shift();
    if (importer === undefined || visited.has(importer)) continue;
    visited.add(importer);

    for (const dependency of graph.get(importer) ?? []) {
      const forbiddenPackage = forbiddenWebPackages.some((packageName) =>
        isPackage(dependency.specifier, packageName),
      );
      const forbiddenLocalTarget =
        dependency.resolvedPath !== undefined && isObsidianLocalTarget(root, dependency.resolvedPath);
      if (forbiddenPackage || forbiddenLocalTarget) {
        violations.push({
          code: "WEB_OBSIDIAN_DEPENDENCY",
          importer: normalisePath(relative(root, importer)),
          specifier: dependency.specifier,
          target:
            dependency.resolvedPath === undefined
              ? undefined
              : normalisePath(relative(root, dependency.resolvedPath)),
        });
      }
      if (dependency.resolvedPath !== undefined && graph.has(dependency.resolvedPath)) {
        queue.push(dependency.resolvedPath);
      }
    }
  }

  return violations;
}
