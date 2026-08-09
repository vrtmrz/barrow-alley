import type { IncomingFileMeta, IncomingFileWriter, Sink } from "../../../src/core/files.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES } from "../../../src/core/transfer/limits.js";

/** Verified browser download handed to a host presentation capability. */
export interface BrowserDownload {
    readonly fileName: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
}

/** Starts one user-visible browser download after receiver verification. */
export interface BrowserDownloadTarget {
    download(file: BrowserDownload): void | Promise<void>;
}

/** Narrow object-URL subset used by the DOM target and injectable tests. */
export interface BrowserObjectUrlFactory {
    createObjectURL(value: Blob): string;
    revokeObjectURL(url: string): void;
}

export type BrowserDownloadSinkErrorCode =
    | "FILE_TOO_LARGE"
    | "INVALID_FILE_NAME"
    | "INVALID_WRITE";

/** Stable failure while buffering or starting a verified browser download. */
export class BrowserDownloadSinkError extends Error {
    readonly code: BrowserDownloadSinkErrorCode;

    constructor(code: BrowserDownloadSinkErrorCode, message: string) {
        super(message);
        this.name = "BrowserDownloadSinkError";
        this.code = code;
    }
}

/**
 * Browser DOM implementation which clicks a temporary download anchor.
 *
 * Object URLs are revoked on a later task so the browser can consume the click
 * first. The temporary anchor is removed synchronously and never receives peer HTML.
 */
export class DomBrowserDownloadTarget implements BrowserDownloadTarget {
    readonly #document: Document;
    readonly #objectUrls: BrowserObjectUrlFactory;
    readonly #schedule: (callback: () => void) => void;

    constructor(
        document: Document,
        objectUrls: BrowserObjectUrlFactory,
        schedule: (callback: () => void) => void,
    ) {
        this.#document = document;
        this.#objectUrls = objectUrls;
        this.#schedule = schedule;
    }

    download(file: BrowserDownload): void {
        const blob = new Blob([file.bytes.slice().buffer], { type: file.mimeType });
        const url = this.#objectUrls.createObjectURL(blob);
        const anchor = this.#document.createElement("a");
        anchor.href = url;
        anchor.download = file.fileName;
        anchor.hidden = true;
        this.#document.body.append(anchor);
        try {
            anchor.click();
        } finally {
            anchor.remove();
            this.#schedule(() => this.#objectUrls.revokeObjectURL(url));
        }
    }
}

/**
 * Buffers one incoming browser file and starts its download only after core
 * byte-count and SHA-256 verification has called `complete()`.
 */
export class BrowserDownloadSink implements Sink {
    readonly #target: BrowserDownloadTarget;

    constructor(target: BrowserDownloadTarget) {
        this.#target = target;
    }

    async begin(meta: IncomingFileMeta): Promise<IncomingFileWriter> {
        assertDownloadMeta(meta);
        const bytes = new Uint8Array(meta.size);
        let offset = 0;
        let state: "open" | "committing" | "finished" | "aborted" = "open";
        return {
            write: async (chunk) => {
                if (state !== "open" || offset + chunk.byteLength > bytes.byteLength) {
                    throw new BrowserDownloadSinkError(
                        "INVALID_WRITE",
                        "Incoming bytes do not fit the browser download.",
                    );
                }
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            },
            complete: async () => {
                if (state !== "open" || offset !== bytes.byteLength) {
                    throw new BrowserDownloadSinkError(
                        "INVALID_WRITE",
                        "The browser download does not contain the declared file size.",
                    );
                }
                state = "committing";
                await this.#target.download({
                    fileName: meta.displayName,
                    mimeType: meta.mimeType ?? "application/octet-stream",
                    bytes,
                });
                state = "finished";
            },
            abort: async () => {
                if (state === "finished" || state === "aborted") return;
                state = "aborted";
                bytes.fill(0);
            },
        };
    }
}

function assertDownloadMeta(meta: IncomingFileMeta): void {
    if (meta.size > MAX_BUFFERED_FILE_SIZE_BYTES) {
        throw new BrowserDownloadSinkError(
            "FILE_TOO_LARGE",
            `'${meta.displayName}' exceeds the 100 MiB file limit.`,
        );
    }
    if (
        meta.displayName.length === 0 ||
        meta.displayName === "." ||
        meta.displayName === ".." ||
        meta.displayName.includes("/") ||
        meta.displayName.includes("\\") ||
        [...meta.displayName].some((character) => {
            const codePoint = character.codePointAt(0);
            return codePoint === undefined || codePoint <= 31 || codePoint === 127;
        })
    ) {
        throw new BrowserDownloadSinkError(
            "INVALID_FILE_NAME",
            "The sender supplied an unsafe download file name.",
        );
    }
}
