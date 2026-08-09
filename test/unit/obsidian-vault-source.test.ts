import { describe, expect, it } from "vitest";

import { MAX_BUFFERED_FILE_SIZE_BYTES } from "../../src/core/index.js";
import {
    ObsidianVaultSource,
    type VaultBinaryFile,
    type VaultBinaryReader,
    VaultSourceError,
} from "../../src/obsidian/vault-source.js";

function file(path: string, size: number, mtime = 1): VaultBinaryFile {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const extensionIndex = name.lastIndexOf(".");
    return {
        path,
        name,
        extension: extensionIndex < 0 ? "" : name.slice(extensionIndex + 1),
        stat: { size, mtime },
    };
}

class MemoryVaultReader implements VaultBinaryReader {
    readonly #values: ReadonlyMap<string, Uint8Array>;
    activeReads = 0;
    maximumActiveReads = 0;
    readCount = 0;

    constructor(values: ReadonlyMap<string, Uint8Array>) {
        this.#values = values;
    }

    async readBinary(target: VaultBinaryFile): Promise<ArrayBuffer> {
        this.readCount += 1;
        this.activeReads += 1;
        this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);
        await Promise.resolve();
        this.activeReads -= 1;
        const value = this.#values.get(target.path);
        if (value === undefined) throw new Error(`Missing fixture: ${target.path}`);
        return value.slice().buffer;
    }
}

describe("Obsidian Vault source", () => {
    it("hashes selected files sequentially and exposes no Vault paths", async () => {
        const first = file("private/notes.md", 5, 10);
        const second = file("images/diagram.png", 4, 20);
        const reader = new MemoryVaultReader(
            new Map([
                [first.path, new TextEncoder().encode("notes")],
                [second.path, Uint8Array.of(1, 2, 3, 4)],
            ]),
        );
        const source = new ObsidianVaultSource(reader, [first, second]);

        const items = await source.list();

        expect(reader.maximumActiveReads).toBe(1);
        expect(items).toEqual([
            {
                id: "source-1",
                displayName: "notes.md",
                size: 5,
                mimeType: "text/markdown",
                hash: "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309",
                sourceVersion: "10:5",
            },
            {
                id: "source-2",
                displayName: "diagram.png",
                size: 4,
                mimeType: "image/png",
                hash: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
                sourceVersion: "20:4",
            },
        ]);
        expect(JSON.stringify(items)).not.toMatch(/private|images/iu);
    });

    it("creates safe distinguishing labels for duplicate basenames", async () => {
        const first = file("one/report.pdf", 1);
        const second = file("two/report.pdf", 1);
        const reader = new MemoryVaultReader(
            new Map([
                [first.path, Uint8Array.of(1)],
                [second.path, Uint8Array.of(2)],
            ]),
        );

        const items = await new ObsidianVaultSource(reader, [first, second]).list();

        expect(items.map((item) => item.displayName)).toEqual(["report (1).pdf", "report (2).pdf"]);
    });

    it("caches prepared metadata but reads a fresh snapshot for transfer", async () => {
        const selected = file("notes.md", 5);
        const reader = new MemoryVaultReader(
            new Map([[selected.path, new TextEncoder().encode("notes")]]),
        );
        const source = new ObsidianVaultSource(reader, [selected]);

        await source.list();
        await source.list();
        const bytes = await source.open("source-1");

        expect(reader.readCount).toBe(2);
        expect(bytes).toEqual(new TextEncoder().encode("notes"));
    });

    it("rejects an empty selection, duplicate paths, unknown IDs, and oversized files", async () => {
        const selected = file("large.bin", MAX_BUFFERED_FILE_SIZE_BYTES + 1);
        const reader = new MemoryVaultReader(new Map());

        expect(() => new ObsidianVaultSource(reader, [])).toThrowError(VaultSourceError);
        expect(() => new ObsidianVaultSource(reader, [selected, selected])).toThrowError(
            VaultSourceError,
        );
        await expect(new ObsidianVaultSource(reader, [selected]).list()).rejects.toEqual(
            expect.objectContaining<Partial<VaultSourceError>>({ code: "FILE_TOO_LARGE" }),
        );
        expect(reader.readCount).toBe(0);

        const small = file("small.bin", 1);
        const smallSource = new ObsidianVaultSource(
            new MemoryVaultReader(new Map([[small.path, Uint8Array.of(1)]])),
            [small],
        );
        await expect(smallSource.open("source-2")).rejects.toEqual(
            expect.objectContaining<Partial<VaultSourceError>>({ code: "UNKNOWN_FILE" }),
        );
    });
});
