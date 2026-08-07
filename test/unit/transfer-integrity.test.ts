import { describe, expect, it } from "vitest";

import {
  BARROW_ALLEY_PROTOCOL_VERSION,
  IncomingFileTransfer,
  TransferError,
  sha256Hex,
  type FileBeginMessage,
  type ManifestItem,
  type TransferProgress,
} from "../../src/core/index.js";
import { InMemorySink } from "../fixtures/in-memory-files.js";

const bytes = Uint8Array.of(1, 2, 3, 4);
const expectedHash = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

const meta: ManifestItem = {
  id: "item-1",
  displayName: "data.bin",
  size: bytes.byteLength,
  hash: expectedHash,
};

const begin: FileBeginMessage = {
  type: "file-begin",
  protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
  sessionId: "session-1",
  fileId: meta.id,
  displayName: meta.displayName,
  size: meta.size,
  hash: meta.hash,
  chunkSize: 2,
};

describe("transfer integrity", () => {
  it("hashes a complete byte array with Web Crypto", async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("completes only contiguous chunks with matching size and hash", async () => {
    const sink = new InMemorySink();
    const progress: TransferProgress[] = [];
    const transfer = await IncomingFileTransfer.start({
      begin,
      expected: meta,
      sink,
      onProgress: (event) => progress.push(event),
    });

    await transfer.write({
      type: "file-chunk",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 0,
      offset: 0,
      data: bytes.slice(0, 2),
    });
    await transfer.write({
      type: "file-chunk",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 1,
      offset: 2,
      data: bytes.slice(2),
    });
    await transfer.complete({
      type: "file-end",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      bytesSent: bytes.byteLength,
      hash: expectedHash,
    });

    expect(sink.completed.get(meta.id)?.bytes).toEqual(bytes);
    expect(sink.aborted).not.toContain(meta.id);
    expect(progress.map(({ transferredBytes }) => transferredBytes)).toEqual([0, 2, 4]);
  });

  it("rejects duplicate byte ranges and aborts the destination", async () => {
    const sink = new InMemorySink();
    const transfer = await IncomingFileTransfer.start({ begin, expected: meta, sink });
    const firstChunk = {
      type: "file-chunk" as const,
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 0,
      offset: 0,
      data: bytes.slice(0, 2),
    };

    await transfer.write(firstChunk);
    await expect(transfer.write(firstChunk)).rejects.toMatchObject({
      code: "TRANSFER_FAILED",
    } satisfies Partial<TransferError>);
    expect(sink.completed.size).toBe(0);
    expect(sink.aborted).toContain(meta.id);
  });

  it("rejects missing bytes and corrupt content without completing the destination", async () => {
    const missingSink = new InMemorySink();
    const missing = await IncomingFileTransfer.start({ begin, expected: meta, sink: missingSink });
    await missing.write({
      type: "file-chunk",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 0,
      offset: 0,
      data: bytes.slice(0, 2),
    });
    await expect(
      missing.complete({
        type: "file-end",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        sessionId: begin.sessionId,
        fileId: begin.fileId,
        bytesSent: bytes.byteLength,
        hash: expectedHash,
      }),
    ).rejects.toMatchObject({ code: "SIZE_MISMATCH" } satisfies Partial<TransferError>);
    expect(missingSink.completed.size).toBe(0);
    expect(missingSink.aborted).toContain(meta.id);

    const corruptSink = new InMemorySink();
    const corrupt = await IncomingFileTransfer.start({ begin, expected: meta, sink: corruptSink });
    await corrupt.write({
      type: "file-chunk",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 0,
      offset: 0,
      data: Uint8Array.of(1, 2),
    });
    await corrupt.write({
      type: "file-chunk",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 1,
      offset: 2,
      data: Uint8Array.of(3, 5),
    });
    await expect(
      corrupt.complete({
        type: "file-end",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        sessionId: begin.sessionId,
        fileId: begin.fileId,
        bytesSent: bytes.byteLength,
        hash: expectedHash,
      }),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" } satisfies Partial<TransferError>);
    expect(corruptSink.completed.size).toBe(0);
    expect(corruptSink.aborted).toContain(meta.id);
  });

  it("aborts a cancelled destination", async () => {
    const sink = new InMemorySink();
    const transfer = await IncomingFileTransfer.start({ begin, expected: meta, sink });

    await transfer.cancel();

    expect(sink.completed.size).toBe(0);
    expect(sink.aborted).toContain(meta.id);
  });

  it("completes an empty file without requiring a chunk frame", async () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const emptyMeta: ManifestItem = {
      id: "empty",
      displayName: "empty.bin",
      size: 0,
      hash: emptyHash,
    };
    const emptyBegin: FileBeginMessage = {
      type: "file-begin",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: "session-1",
      fileId: emptyMeta.id,
      displayName: emptyMeta.displayName,
      size: 0,
      hash: emptyHash,
      chunkSize: 2,
    };
    const sink = new InMemorySink();
    const transfer = await IncomingFileTransfer.start({
      begin: emptyBegin,
      expected: emptyMeta,
      sink,
    });

    await transfer.complete({
      type: "file-end",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: emptyBegin.sessionId,
      fileId: emptyBegin.fileId,
      bytesSent: 0,
      hash: emptyHash,
    });

    expect(sink.completed.get(emptyMeta.id)?.bytes).toEqual(new Uint8Array());
  });

  it("reports destination cleanup failure without hiding it as an integrity error", async () => {
    const transfer = await IncomingFileTransfer.start({
      begin,
      expected: meta,
      sink: {
        begin: async () => ({
          write: async () => {},
          complete: async () => {},
          abort: async () => {
            throw new Error("cleanup failed");
          },
        }),
      },
    });
    const firstChunk = {
      type: "file-chunk" as const,
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: begin.sessionId,
      fileId: begin.fileId,
      index: 0,
      offset: 0,
      data: bytes.slice(0, 2),
    };

    await transfer.write(firstChunk);
    await expect(transfer.write(firstChunk)).rejects.toMatchObject({
      code: "DESTINATION_FAILED",
    } satisfies Partial<TransferError>);
  });
});
