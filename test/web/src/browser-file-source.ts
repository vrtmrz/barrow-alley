import type { Source, SourceItem } from "../../../src/core/files.js";
import { sha256Hex } from "../../../src/core/transfer/integrity.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES } from "../../../src/core/transfer/limits.js";

/** Minimal browser `File` surface used by the source adapter and Node tests. */
export interface BrowserSourceFile {
    readonly name: string;
    readonly size: number;
    readonly type: string;
    readonly lastModified: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}

export type BrowserFileSourceErrorCode =
    | "EMPTY_SELECTION"
    | "FILE_TOO_LARGE"
    | "INVALID_FILE_NAME"
    | "SOURCE_CHANGED"
    | "UNKNOWN_FILE";

/** Actionable failure while preparing or reopening files selected in a browser. */
export class BrowserFileSourceError extends Error {
    readonly code: BrowserFileSourceErrorCode;

    constructor(code: BrowserFileSourceErrorCode, message: string) {
        super(message);
        this.name = "BrowserFileSourceError";
        this.code = code;
    }
}

interface SelectedBrowserFile<TFile extends BrowserSourceFile> {
    readonly id: string;
    readonly file: TFile;
    readonly displayName: string;
    readonly version: string;
}

/**
 * Adapts one explicit browser file selection to the host-neutral `Source` contract.
 *
 * Browsers expose complete `File.arrayBuffer()` reads, so files are hashed one at
 * a time and kept under the shared 100 MiB limit. Browser-supplied basenames are
 * the only labels exposed; directory information never enters the manifest.
 */
export class BrowserFileSource<TFile extends BrowserSourceFile = BrowserSourceFile>
    implements Source {
    readonly #selected: readonly SelectedBrowserFile<TFile>[];
    #prepared: readonly SourceItem[] | undefined;

    constructor(files: readonly TFile[]) {
        if (files.length === 0) {
            throw new BrowserFileSourceError("EMPTY_SELECTION", "Select at least one file.");
        }
        for (const file of files) assertSafeBrowserFileName(file.name);
        const displayNames = distinguishDuplicateNames(files.map((file) => file.name));
        this.#selected = files.map((file, index) => ({
            id: `source-${String(index + 1)}`,
            file,
            displayName: displayNames[index] ?? file.name,
            version: browserFileVersion(file),
        }));
    }

    async list(): Promise<readonly SourceItem[]> {
        if (this.#prepared !== undefined) return this.#prepared;
        const prepared: SourceItem[] = [];
        // Await sequentially so preparation never reads and hashes several whole
        // browser files concurrently on memory-constrained devices.
        for (const selected of this.#selected) {
            const bytes = await readCurrentFile(selected);
            const base = {
                id: selected.id,
                displayName: selected.displayName,
                size: bytes.byteLength,
                hash: await sha256Hex(bytes),
                sourceVersion: selected.version,
            };
            prepared.push(
                selected.file.type.length === 0 ? base : { ...base, mimeType: selected.file.type },
            );
        }
        this.#prepared = prepared;
        return prepared;
    }

    async open(itemId: string): Promise<Uint8Array> {
        const selected = this.#selected.find(({ id }) => id === itemId);
        if (selected === undefined) {
            throw new BrowserFileSourceError(
                "UNKNOWN_FILE",
                "The requested selected file is not available.",
            );
        }
        return readCurrentFile(selected);
    }
}

async function readCurrentFile<TFile extends BrowserSourceFile>(
    selected: SelectedBrowserFile<TFile>,
): Promise<Uint8Array> {
    if (selected.file.size > MAX_BUFFERED_FILE_SIZE_BYTES) {
        throw new BrowserFileSourceError(
            "FILE_TOO_LARGE",
            `'${selected.displayName}' exceeds the 100 MiB file limit.`,
        );
    }
    if (browserFileVersion(selected.file) !== selected.version) {
        throw sourceChanged(selected.displayName);
    }
    const bytes = new Uint8Array(await selected.file.arrayBuffer());
    if (
        bytes.byteLength !== selected.file.size ||
        browserFileVersion(selected.file) !== selected.version
    ) {
        throw sourceChanged(selected.displayName);
    }
    return bytes;
}

function browserFileVersion(file: BrowserSourceFile): string {
    return `${String(file.lastModified)}:${String(file.size)}`;
}

function sourceChanged(displayName: string): BrowserFileSourceError {
    return new BrowserFileSourceError(
        "SOURCE_CHANGED",
        `'${displayName}' changed after it was selected. Set up a new pitch.`,
    );
}

function assertSafeBrowserFileName(fileName: string): void {
    if (
        fileName.length === 0 ||
        fileName === "." ||
        fileName === ".." ||
        fileName.includes("/") ||
        fileName.includes("\\") ||
        [...fileName].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint === undefined || codePoint <= 31 || codePoint === 127;
        })
    ) {
        throw new BrowserFileSourceError(
            "INVALID_FILE_NAME",
            "A selected file has an unsafe browser file name.",
        );
    }
}

function distinguishDuplicateNames(names: readonly string[]): readonly string[] {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    const seen = new Map<string, number>();
    return names.map((name) => {
        if ((counts.get(name) ?? 0) === 1) return name;
        const occurrence = (seen.get(name) ?? 0) + 1;
        seen.set(name, occurrence);
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        return `${stem} (${String(occurrence)})${extension}`;
    });
}
