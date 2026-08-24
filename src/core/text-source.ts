import type { Source, SourceItem } from "./files.js";
import { sha256Hex } from "./transfer/integrity.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES } from "./transfer/limits.js";

const TEXT_SOURCE_ID = "shared-text";

export type TextSourceErrorCode = "EMPTY_TEXT" | "FILE_TOO_LARGE" | "UNKNOWN_ITEM";

/** A safe failure while preparing or reopening an entered text value. */
export class TextSourceError extends Error {
    readonly code: TextSourceErrorCode;

    constructor(code: TextSourceErrorCode, message: string) {
        super(message);
        this.name = "TextSourceError";
        this.code = code;
    }
}

/**
 * Exposes one entered text value through the normal file-transfer boundary.
 *
 * The text is encoded once and retained as an immutable UTF-8 snapshot. This
 * lets the normal manifest, admission, integrity, and destination policies
 * handle text without adding a second protocol message family.
 */
export class TextSource implements Source {
    readonly #bytes: Uint8Array;
    readonly #displayName: string;
    #item: SourceItem | undefined;

    constructor(text: string, createdAt: Date = new Date()) {
        if (text.length === 0) {
            throw new TextSourceError("EMPTY_TEXT", "Enter text to share.");
        }
        const bytes = new TextEncoder().encode(text);
        const displayName = formatSharedTextFileName(createdAt);
        if (bytes.byteLength > MAX_BUFFERED_FILE_SIZE_BYTES) {
            throw new TextSourceError(
                "FILE_TOO_LARGE",
                `'${displayName}' exceeds the 100 MiB file limit.`,
            );
        }
        this.#bytes = bytes;
        this.#displayName = displayName;
    }

    /** Builds and caches the single receiver-facing manifest item. */
    async list(): Promise<readonly SourceItem[]> {
        this.#item ??= {
            id: TEXT_SOURCE_ID,
            displayName: this.#displayName,
            size: this.#bytes.byteLength,
            mimeType: "text/plain",
            hash: await sha256Hex(this.#bytes),
        };
        return [this.#item];
    }

    /** Returns a fresh copy so transfer code cannot mutate the retained text. */
    async open(itemId: string): Promise<Uint8Array> {
        if (itemId !== TEXT_SOURCE_ID) {
            throw new TextSourceError(
                "UNKNOWN_ITEM",
                "The requested text is not available.",
            );
        }
        return this.#bytes.slice();
    }
}

/** Formats sender-local time as a portable, sortable filename. */
export function formatSharedTextFileName(createdAt: Date): string {
    const date = [
        createdAt.getFullYear(),
        createdAt.getMonth() + 1,
        createdAt.getDate(),
    ].map((part, index) => index === 0 ? String(part).padStart(4, "0") : twoDigits(part));
    const time = [
        createdAt.getHours(),
        createdAt.getMinutes(),
        createdAt.getSeconds(),
    ].map(twoDigits);
    return `shared-${date.join("")}-${time.join("")}.txt`;
}

function twoDigits(value: number): string {
    return String(value).padStart(2, "0");
}
