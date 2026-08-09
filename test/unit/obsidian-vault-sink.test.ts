import { describe, expect, it } from "vitest";

import {
    BARROW_ALLEY_PROTOCOL_VERSION,
    IncomingFileTransfer,
    type ManifestItem,
} from "../../src/core/index.js";
import {
    ObsidianVaultSink,
    type VaultBinaryDestination,
    type VaultDestinationFile,
    type VaultDestinationFolder,
    VaultSinkError,
} from "../../src/obsidian/vault-sink.js";

const meta: ManifestItem = {
    id: "item-1",
    displayName: "notes.md",
    size: 5,
    hash: "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309",
};

interface MemoryFile extends VaultDestinationFile {
    readonly name: string;
}

class MemoryVault implements VaultBinaryDestination<MemoryFile> {
    readonly root: VaultDestinationFolder = { path: "/" };
    readonly folders = new Map<string, VaultDestinationFolder>([[
        "/",
        this.root,
    ]]);
    readonly files = new Map<string, MemoryFile>();
    readonly bytes = new Map<string, Uint8Array>();
    #mtime = 1;

    getRoot(): VaultDestinationFolder {
        return this.root;
    }

    getFileByPath(path: string): MemoryFile | null {
        return this.files.get(path) ?? null;
    }

    getFolderByPath(path: string): VaultDestinationFolder | null {
        return this.folders.get(path) ?? null;
    }

    async createBinary(path: string, data: ArrayBuffer): Promise<MemoryFile> {
        if (this.files.has(path) || this.folders.has(path)) {
            throw new Error("Path exists.");
        }
        const value = new Uint8Array(data.slice(0));
        const created = this.file(path, value.byteLength);
        this.files.set(path, created);
        this.bytes.set(path, value);
        return created;
    }

    async modifyBinary(file: MemoryFile, data: ArrayBuffer): Promise<void> {
        if (this.files.get(file.path) !== file) {
            throw new Error("File changed.");
        }
        const value = new Uint8Array(data.slice(0));
        const modified = this.file(file.path, value.byteLength);
        this.files.set(file.path, modified);
        this.bytes.set(file.path, value);
    }

    addFile(path: string, value: Uint8Array): MemoryFile {
        const added = this.file(path, value.byteLength);
        this.files.set(path, added);
        this.bytes.set(path, value.slice());
        return added;
    }

    private file(path: string, size: number): MemoryFile {
        return {
            path,
            name: path.slice(path.lastIndexOf("/") + 1),
            stat: { size, mtime: this.#mtime++ },
        };
    }
}

describe("Obsidian Vault sink", () => {
    it("creates no Vault entry until the verified writer completes", async () => {
        const vault = new MemoryVault();
        const sink = new ObsidianVaultSink(vault, vault.root);
        sink.prepare(meta);
        const writer = await sink.begin(meta);

        await writer.write(new TextEncoder().encode("no"));
        expect(vault.getFileByPath("notes.md")).toBeNull();
        await writer.write(new TextEncoder().encode("tes"));
        expect(vault.getFileByPath("notes.md")).toBeNull();

        await writer.complete();

        expect(vault.bytes.get("notes.md")).toEqual(
            new TextEncoder().encode("notes"),
        );
    });

    it("leaves no partial file when an incoming write is aborted", async () => {
        const vault = new MemoryVault();
        const sink = new ObsidianVaultSink(vault, vault.root);
        sink.prepare(meta);
        const writer = await sink.begin(meta);

        await writer.write(new TextEncoder().encode("no"));
        await writer.abort(new Error("Transfer failed."));

        expect(vault.getFileByPath("notes.md")).toBeNull();
        expect(vault.bytes.size).toBe(0);
    });

    it("does not create a completed Vault file when core integrity verification fails", async () => {
        const vault = new MemoryVault();
        const sink = new ObsidianVaultSink(vault, vault.root);
        sink.prepare(meta);
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

        expect(vault.getFileByPath("notes.md")).toBeNull();
        expect(vault.bytes.size).toBe(0);
    });

    it("requires explicit overwrite and commits it only after completion", async () => {
        const vault = new MemoryVault();
        const original = new TextEncoder().encode("old");
        vault.addFile("notes.md", original);
        const sink = new ObsidianVaultSink(vault, vault.root);

        expect(() => sink.prepare(meta)).toThrowError(
            expect.objectContaining<Partial<VaultSinkError>>({
                code: "DESTINATION_EXISTS",
            }),
        );
        sink.prepare(meta, { overwrite: true });
        const writer = await sink.begin(meta);
        await writer.write(new TextEncoder().encode("notes"));
        expect(vault.bytes.get("notes.md")).toEqual(original);

        await writer.complete();

        expect(vault.bytes.get("notes.md")).toEqual(
            new TextEncoder().encode("notes"),
        );
    });

    it("does not overwrite a destination which appears or changes during transfer", async () => {
        const createVault = new MemoryVault();
        const createSink = new ObsidianVaultSink(createVault, createVault.root);
        createSink.prepare(meta);
        const createWriter = await createSink.begin(meta);
        await createWriter.write(new TextEncoder().encode("notes"));
        const rival = new TextEncoder().encode("rival");
        createVault.addFile("notes.md", rival);

        await expect(createWriter.complete()).rejects.toEqual(
            expect.objectContaining<Partial<VaultSinkError>>({
                code: "DESTINATION_CHANGED",
            }),
        );
        expect(createVault.bytes.get("notes.md")).toEqual(rival);

        const overwriteVault = new MemoryVault();
        overwriteVault.addFile("notes.md", new TextEncoder().encode("old"));
        const overwriteSink = new ObsidianVaultSink(
            overwriteVault,
            overwriteVault.root,
        );
        overwriteSink.prepare(meta, { overwrite: true });
        const overwriteWriter = await overwriteSink.begin(meta);
        await overwriteWriter.write(new TextEncoder().encode("notes"));
        const newer = new TextEncoder().encode("newer");
        overwriteVault.addFile("notes.md", newer);

        await expect(overwriteWriter.complete()).rejects.toEqual(
            expect.objectContaining<Partial<VaultSinkError>>({
                code: "DESTINATION_CHANGED",
            }),
        );
        expect(overwriteVault.bytes.get("notes.md")).toEqual(newer);
    });

    it("rejects paths, reserved names, stale folders, and unprepared transfers", async () => {
        const vault = new MemoryVault();
        const folder = { path: "incoming" };
        vault.folders.set(folder.path, folder);
        const sink = new ObsidianVaultSink(vault, folder);

        expect(() => sink.prepare(meta, { fileName: "../notes.md" }))
            .toThrowError(
                expect.objectContaining<Partial<VaultSinkError>>({
                    code: "INVALID_FILE_NAME",
                }),
            );
        expect(() => sink.prepare(meta, { fileName: "CON.md" })).toThrowError(
            expect.objectContaining<Partial<VaultSinkError>>({
                code: "INVALID_FILE_NAME",
            }),
        );
        await expect(sink.begin(meta)).rejects.toEqual(
            expect.objectContaining<Partial<VaultSinkError>>({
                code: "DESTINATION_NOT_PREPARED",
            }),
        );

        vault.folders.delete(folder.path);
        expect(() => sink.prepare(meta)).toThrowError(
            expect.objectContaining<Partial<VaultSinkError>>({
                code: "INVALID_DESTINATION_FOLDER",
            }),
        );
    });
});
