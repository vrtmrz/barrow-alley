import { describe, expect, it } from "vitest";

import {
    BARROW_ALLEY_PROTOCOL_VERSION,
    IncomingFileTransfer,
    type ManifestItem,
    MAX_BUFFERED_FILE_SIZE_BYTES,
} from "../../src/core/index.js";
import {
    type BrowserDownload,
    BrowserDownloadSink,
    BrowserDownloadSinkError,
    type BrowserDownloadTarget,
} from "../web/src/browser-download-sink.js";
import {
    BrowserFileSource,
    BrowserFileSourceError,
    type BrowserSourceFile,
} from "../web/src/browser-file-source.js";

const NOTES_HASH = "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309";

class MemoryBrowserFile implements BrowserSourceFile {
    readonly name: string;
    readonly type: string;
    lastModified: number;
    size: number;
    bytes: Uint8Array;
    activeReads = 0;
    maximumActiveReads = 0;
    readCount = 0;

    constructor(name: string, bytes: Uint8Array, type = "", lastModified = 1) {
        this.name = name;
        this.bytes = bytes;
        this.size = bytes.byteLength;
        this.type = type;
        this.lastModified = lastModified;
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        this.readCount += 1;
        this.activeReads += 1;
        this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);
        await Promise.resolve();
        this.activeReads -= 1;
        return this.bytes.slice().buffer;
    }
}

class RecordingDownloadTarget implements BrowserDownloadTarget {
    readonly downloads: BrowserDownload[] = [];

    download(file: BrowserDownload): void {
        this.downloads.push({ ...file, bytes: file.bytes.slice() });
    }
}

const meta: ManifestItem = {
    id: "item-1",
    displayName: "notes.md",
    size: 5,
    mimeType: "text/markdown",
    hash: NOTES_HASH,
};

describe("browser file source", () => {
    it("hashes complete selected files sequentially and exposes safe labels", async () => {
        const first = new MemoryBrowserFile(
            "notes.md",
            new TextEncoder().encode("notes"),
            "text/markdown",
            10,
        );
        const second = new MemoryBrowserFile("notes.md", Uint8Array.of(1), "", 20);
        const source = new BrowserFileSource([first, second]);

        const items = await source.list();

        expect(items.map(({ displayName }) => displayName)).toEqual([
            "notes (1).md",
            "notes (2).md",
        ]);
        expect(items[0]).toEqual({
            id: "source-1",
            displayName: "notes (1).md",
            size: 5,
            mimeType: "text/markdown",
            hash: NOTES_HASH,
            sourceVersion: "10:5",
        });
        expect(first.maximumActiveReads).toBe(1);
        expect(second.maximumActiveReads).toBe(1);
        expect(first.readCount).toBe(1);
        expect(second.readCount).toBe(1);
    });

    it("caches metadata but reopens a current snapshot for transfer", async () => {
        const file = new MemoryBrowserFile("notes.md", new TextEncoder().encode("notes"));
        const source = new BrowserFileSource([file]);

        await source.list();
        await source.list();
        await expect(source.open("source-1")).resolves.toEqual(
            new TextEncoder().encode("notes"),
        );

        expect(file.readCount).toBe(2);
    });

    it("rejects unsafe, changed, unknown, empty, and oversized selections", async () => {
        expect(() => new BrowserFileSource([])).toThrowError(BrowserFileSourceError);
        expect(() =>
            new BrowserFileSource([
                new MemoryBrowserFile("private/notes.md", Uint8Array.of(1)),
            ])
        ).toThrowError(
            expect.objectContaining<Partial<BrowserFileSourceError>>({
                code: "INVALID_FILE_NAME",
            }),
        );

        const changed = new MemoryBrowserFile("notes.md", new TextEncoder().encode("notes"));
        const source = new BrowserFileSource([changed]);
        await source.list();
        changed.lastModified += 1;
        await expect(source.open("source-1")).rejects.toEqual(
            expect.objectContaining<Partial<BrowserFileSourceError>>({ code: "SOURCE_CHANGED" }),
        );
        await expect(source.open("unknown")).rejects.toEqual(
            expect.objectContaining<Partial<BrowserFileSourceError>>({ code: "UNKNOWN_FILE" }),
        );

        const oversized = new MemoryBrowserFile("large.bin", new Uint8Array());
        oversized.size = MAX_BUFFERED_FILE_SIZE_BYTES + 1;
        await expect(new BrowserFileSource([oversized]).list()).rejects.toEqual(
            expect.objectContaining<Partial<BrowserFileSourceError>>({ code: "FILE_TOO_LARGE" }),
        );
        expect(oversized.readCount).toBe(0);
    });
});

describe("browser download sink", () => {
    it("starts no download until the verified writer completes", async () => {
        const target = new RecordingDownloadTarget();
        const writer = await new BrowserDownloadSink(target).begin(meta);

        await writer.write(new TextEncoder().encode("no"));
        await writer.write(new TextEncoder().encode("tes"));
        expect(target.downloads).toEqual([]);

        await writer.complete();

        expect(target.downloads).toEqual([
            {
                fileName: "notes.md",
                mimeType: "text/markdown",
                bytes: new TextEncoder().encode("notes"),
            },
        ]);
    });

    it("starts no download after cancellation or failed integrity verification", async () => {
        const cancelledTarget = new RecordingDownloadTarget();
        const cancelledWriter = await new BrowserDownloadSink(cancelledTarget).begin(meta);
        await cancelledWriter.write(new TextEncoder().encode("no"));
        await cancelledWriter.abort();
        expect(cancelledTarget.downloads).toEqual([]);

        const corruptTarget = new RecordingDownloadTarget();
        const sink = new BrowserDownloadSink(corruptTarget);
        const transfer = await IncomingFileTransfer.start({
            begin: {
                type: "file-begin",
                protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
                sessionId: "session-1",
                fileId: meta.id,
                displayName: meta.displayName,
                size: meta.size,
                hash: meta.hash,
                chunkSize: meta.size,
            },
            expected: meta,
            sink,
        });
        await transfer.write({
            type: "file-chunk",
            protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
            sessionId: "session-1",
            fileId: meta.id,
            index: 0,
            offset: 0,
            data: new TextEncoder().encode("wrong"),
        });
        await expect(
            transfer.complete({
                type: "file-end",
                protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
                sessionId: "session-1",
                fileId: meta.id,
                bytesSent: meta.size,
                hash: meta.hash,
            }),
        ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
        expect(corruptTarget.downloads).toEqual([]);
    });

    it("rejects unsafe peer-provided download names", async () => {
        const target = new RecordingDownloadTarget();

        await expect(
            new BrowserDownloadSink(target).begin({ ...meta, displayName: "../notes.md" }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<BrowserDownloadSinkError>>({
                code: "INVALID_FILE_NAME",
            }),
        );
    });
});
