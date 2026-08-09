import type { IncomingFileMeta, IncomingFileWriter, Sink } from "../core/files.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES } from "../core/transfer/limits.js";

/** Minimal TFile shape needed to detect a destination changed after confirmation. */
export interface VaultDestinationFile {
    readonly path: string;
    readonly stat: {
        readonly size: number;
        readonly mtime: number;
    };
}

/** Minimal TFolder shape needed to construct a Vault-relative destination path. */
export interface VaultDestinationFolder {
    readonly path: string;
}

/**
 * Cross-platform Obsidian Vault binary calls used by the receiver.
 *
 * Keeping this capability structural lets the policy be tested without loading
 * Obsidian, while the production `Vault` satisfies it directly.
 */
export interface VaultBinaryDestination<
    TFile extends VaultDestinationFile = VaultDestinationFile,
    TFolder extends VaultDestinationFolder = VaultDestinationFolder,
> {
    getRoot(): TFolder;
    getFileByPath(path: string): TFile | null;
    getFolderByPath(path: string): TFolder | null;
    createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
    modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
}

export type VaultSinkErrorCode =
    | "DESTINATION_CHANGED"
    | "DESTINATION_EXISTS"
    | "DESTINATION_NOT_PREPARED"
    | "FILE_TOO_LARGE"
    | "INVALID_DESTINATION_FOLDER"
    | "INVALID_FILE_NAME"
    | "INVALID_WRITE";

/** Stable receiver-storage failure used by the controller to select conflict UI. */
export class VaultSinkError extends Error {
    readonly code: VaultSinkErrorCode;

    constructor(code: VaultSinkErrorCode, message: string) {
        super(message);
        this.name = "VaultSinkError";
        this.code = code;
    }
}

export interface PrepareVaultDestinationOptions {
    /** Basename to preserve within the chosen folder. Paths are rejected. */
    readonly fileName?: string;
    /** Must be explicitly true before an existing file can be replaced. */
    readonly overwrite?: boolean;
}

export interface PreparedVaultDestination {
    readonly path: string;
    readonly operation: "create" | "overwrite";
}

interface PreparedWrite<TFile extends VaultDestinationFile> {
    readonly meta: IncomingFileMeta;
    readonly path: string;
    readonly existingFile: TFile | undefined;
    readonly existingVersion: string | undefined;
}

/**
 * Buffers one incoming file and commits it to an Obsidian Vault after integrity checks.
 *
 * Obsidian 1.8.7 has complete-file binary writes but no portable atomic temporary-file
 * operation. This adapter therefore creates no Vault entry during transfer. `complete`
 * is invoked by the core only after byte-count and SHA-256 verification, so a failed or
 * cancelled transfer leaves no partial file. The shared 100 MiB limit bounds this buffer.
 */
export class ObsidianVaultSink<
    TFile extends VaultDestinationFile = VaultDestinationFile,
    TFolder extends VaultDestinationFolder = VaultDestinationFolder,
> implements Sink {
    readonly #vault: VaultBinaryDestination<TFile, TFolder>;
    readonly #folder: TFolder;
    #prepared: PreparedWrite<TFile> | undefined;

    constructor(
        vault: VaultBinaryDestination<TFile, TFolder>,
        folder: TFolder,
    ) {
        this.#vault = vault;
        this.#folder = folder;
    }

    /**
     * Reserves one destination decision before the peer is asked to send bytes.
     *
     * Calling this method never writes to the Vault. Existing files require an
     * explicit overwrite choice; otherwise `DESTINATION_EXISTS` is reported so
     * the presentation layer can offer save-as, overwrite, skip, or cancel.
     */
    prepare(
        meta: IncomingFileMeta,
        options: PrepareVaultDestinationOptions = {},
    ): PreparedVaultDestination {
        assertSupportedSize(meta);
        const fileName = options.fileName ?? meta.displayName;
        assertSafeFileName(fileName);
        this.#assertCurrentFolder();

        const path = joinVaultPath(this.#folder.path, fileName);
        const existingFile = this.#vault.getFileByPath(path);
        const existingFolder = this.#vault.getFolderByPath(path);
        if (existingFolder !== null) {
            throw new VaultSinkError(
                options.overwrite === true ? "DESTINATION_CHANGED" : "DESTINATION_EXISTS",
                `A folder exists at '${path}' and cannot be overwritten as a file.`,
            );
        }
        if (existingFile !== null && options.overwrite !== true) {
            throw new VaultSinkError(
                "DESTINATION_EXISTS",
                `'${path}' already exists. Choose another name or confirm overwrite.`,
            );
        }
        if (existingFile === null && options.overwrite === true) {
            throw new VaultSinkError(
                "DESTINATION_CHANGED",
                `The file selected for overwrite no longer exists at '${path}'.`,
            );
        }

        this.#prepared = {
            meta,
            path,
            existingFile: existingFile ?? undefined,
            existingVersion: existingFile === null ? undefined : fileVersion(existingFile),
        };
        return {
            path,
            operation: existingFile === null ? "create" : "overwrite",
        };
    }

    async begin(meta: IncomingFileMeta): Promise<IncomingFileWriter> {
        const prepared = this.#prepared;
        this.#prepared = undefined;
        if (prepared === undefined || !sameIncomingFile(prepared.meta, meta)) {
            throw new VaultSinkError(
                "DESTINATION_NOT_PREPARED",
                "Choose a safe destination before requesting this file.",
            );
        }

        const bytes = new Uint8Array(meta.size);
        let offset = 0;
        let state: "open" | "committing" | "finished" | "aborted" = "open";
        return {
            write: async (chunk) => {
                if (
                    state !== "open" ||
                    offset + chunk.byteLength > bytes.byteLength
                ) {
                    throw new VaultSinkError(
                        "INVALID_WRITE",
                        "Incoming bytes do not fit the prepared destination.",
                    );
                }
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            },
            complete: async () => {
                if (state !== "open" || offset !== bytes.byteLength) {
                    throw new VaultSinkError(
                        "INVALID_WRITE",
                        "The prepared destination does not contain the declared file size.",
                    );
                }
                state = "committing";
                await this.#commit(prepared, bytes);
                state = "finished";
            },
            abort: async () => {
                if (state === "finished" || state === "aborted") return;
                state = "aborted";
                bytes.fill(0);
            },
        };
    }

    #assertCurrentFolder(): void {
        const current = this.#folder.path === "/"
            ? this.#vault.getRoot()
            : this.#vault.getFolderByPath(this.#folder.path);
        if (current !== this.#folder) {
            throw new VaultSinkError(
                "INVALID_DESTINATION_FOLDER",
                "The selected destination folder is no longer available.",
            );
        }
    }

    async #commit(
        prepared: PreparedWrite<TFile>,
        bytes: Uint8Array,
    ): Promise<void> {
        this.#assertCurrentFolder();
        const currentFile = this.#vault.getFileByPath(prepared.path);
        const currentFolder = this.#vault.getFolderByPath(prepared.path);
        if (prepared.existingFile === undefined) {
            if (currentFile !== null || currentFolder !== null) {
                throw new VaultSinkError(
                    "DESTINATION_CHANGED",
                    `The destination '${prepared.path}' appeared during transfer and was not overwritten.`,
                );
            }
            await this.#vault.createBinary(
                prepared.path,
                exactArrayBuffer(bytes),
            );
            return;
        }

        if (
            currentFile !== prepared.existingFile ||
            currentFolder !== null ||
            fileVersion(prepared.existingFile) !== prepared.existingVersion
        ) {
            throw new VaultSinkError(
                "DESTINATION_CHANGED",
                `The destination '${prepared.path}' changed during transfer and was not overwritten.`,
            );
        }
        await this.#vault.modifyBinary(
            prepared.existingFile,
            exactArrayBuffer(bytes),
        );
    }
}

function assertSupportedSize(meta: IncomingFileMeta): void {
    if (meta.size > MAX_BUFFERED_FILE_SIZE_BYTES) {
        throw new VaultSinkError(
            "FILE_TOO_LARGE",
            `'${meta.displayName}' exceeds the 100 MiB limit.`,
        );
    }
}

function assertSafeFileName(fileName: string): void {
    const stem = fileName.split(".", 1)[0]?.toUpperCase() ?? "";
    if (
        fileName.length === 0 ||
        fileName === "." ||
        fileName === ".." ||
        hasPlatformReservedCharacter(fileName) ||
        /[. ]$/u.test(fileName) ||
        /^(?:AUX|CON|NUL|PRN|COM[1-9]|LPT[1-9])$/u.test(stem)
    ) {
        throw new VaultSinkError(
            "INVALID_FILE_NAME",
            "Choose a file name without a path or platform-reserved characters.",
        );
    }
}

function hasPlatformReservedCharacter(fileName: string): boolean {
    const reserved = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
    for (const character of fileName) {
        const codePoint = character.codePointAt(0);
        if (
            reserved.has(character) ||
            codePoint === undefined ||
            codePoint <= 31 ||
            codePoint === 127
        ) {
            return true;
        }
    }
    return false;
}

function joinVaultPath(folderPath: string, fileName: string): string {
    return folderPath === "/" || folderPath === "" ? fileName : `${folderPath}/${fileName}`;
}

function fileVersion(file: VaultDestinationFile): string {
    return `${String(file.stat.mtime)}:${String(file.stat.size)}`;
}

function sameIncomingFile(
    left: IncomingFileMeta,
    right: IncomingFileMeta,
): boolean {
    return (
        left.id === right.id &&
        left.displayName === right.displayName &&
        left.size === right.size &&
        left.hash === right.hash
    );
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer;
}
