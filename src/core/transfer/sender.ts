import type { Source, SourceItem } from "../files.js";
import type { ManifestItem } from "../manifest.js";
import type { ProtocolMessage } from "../protocol/messages.js";
import { BARROW_ALLEY_PROTOCOL_VERSION } from "../protocol/version.js";
import { TransferError } from "./errors.js";
import { sha256Hex } from "./integrity.js";
import {
  DEFAULT_TRANSFER_CHUNK_SIZE_BYTES,
  MAX_BUFFERED_FILE_SIZE_BYTES,
  MAX_TRANSFER_CHUNK_SIZE_BYTES,
} from "./limits.js";
import {
  emitTransferProgress,
  type TransferProgressHandler,
} from "./progress.js";

export interface SendFileOptions {
  readonly sessionId: string;
  readonly fileId: string;
  readonly sourceItem: SourceItem;
  readonly manifestItem: ManifestItem;
  readonly source: Source;
  readonly send: (message: ProtocolMessage) => Promise<void>;
  readonly chunkSize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: TransferProgressHandler;
}

/** Reads, verifies, and sends one file as sequential bounded protocol frames. */
export async function sendFile(options: SendFileOptions): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_TRANSFER_CHUNK_SIZE_BYTES;
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    chunkSize > MAX_TRANSFER_CHUNK_SIZE_BYTES
  ) {
    throw new TransferError("TRANSFER_FAILED", "Configured chunk size is invalid.");
  }

  throwIfAborted(options.signal);
  let bytes: Uint8Array;
  try {
    bytes = await options.source.open(options.sourceItem.id);
  } catch (error) {
    throw new TransferError("TRANSFER_FAILED", "Could not read the source file.", { cause: error });
  }
  throwIfAborted(options.signal);
  if (bytes.byteLength > MAX_BUFFERED_FILE_SIZE_BYTES) {
    throw new TransferError("TRANSFER_FAILED", "File exceeds the buffered transfer limit.");
  }

  const hash = await sha256Hex(bytes);
  throwIfAborted(options.signal);
  if (bytes.byteLength !== options.manifestItem.size || hash !== options.manifestItem.hash) {
    throw new TransferError(
      "SOURCE_CHANGED",
      "Source bytes changed after the manifest was prepared.",
    );
  }

  emitTransferProgress(options.onProgress, {
    fileId: options.fileId,
    transferredBytes: 0,
    totalBytes: bytes.byteLength,
  });
  await options.send({
    type: "file-begin",
    protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
    sessionId: options.sessionId,
    fileId: options.fileId,
    displayName: options.manifestItem.displayName,
    size: bytes.byteLength,
    hash,
    chunkSize,
  });

  let index = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    throwIfAborted(options.signal);
    const data = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
    await options.send({
      type: "file-chunk",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      fileId: options.fileId,
      index,
      offset,
      data,
    });
    index += 1;
    emitTransferProgress(options.onProgress, {
      fileId: options.fileId,
      transferredBytes: offset + data.byteLength,
      totalBytes: bytes.byteLength,
    });
    throwIfAborted(options.signal);
  }

  await options.send({
    type: "file-end",
    protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
    sessionId: options.sessionId,
    fileId: options.fileId,
    bytesSent: bytes.byteLength,
    hash,
  });
  throwIfAborted(options.signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof TransferError) throw signal.reason;
  throw new TransferError("TRANSFER_CANCELLED", "Transfer cancelled.", {
    cause: signal?.reason,
  });
}
