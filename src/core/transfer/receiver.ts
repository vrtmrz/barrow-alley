import type { IncomingFileWriter, Sink } from "../files.js";
import type { ManifestItem } from "../manifest.js";
import type {
  FileBeginMessage,
  FileChunkMessage,
  FileEndMessage,
} from "../protocol/messages.js";
import { TransferError } from "./errors.js";
import { concatenateChunks, sha256Hex } from "./integrity.js";
import { MAX_BUFFERED_FILE_SIZE_BYTES } from "./limits.js";
import {
  emitTransferProgress,
  type TransferProgressHandler,
} from "./progress.js";

export interface IncomingFileTransferOptions {
  /** Validated first frame for the requested file. */
  readonly begin: FileBeginMessage;
  /** Manifest metadata disclosed for the same request. */
  readonly expected: ManifestItem;
  /** Host-owned partial destination. */
  readonly sink: Sink;
  /** Optional presentation observer. */
  readonly onProgress?: TransferProgressHandler;
}

/**
 * Accounts for one incoming framed file and gates destination completion.
 *
 * Chunks are written in order and also retained for the final Web Crypto digest.
 * A wrong range, size, or hash aborts the writer before the error is exposed.
 */
export class IncomingFileTransfer {
  readonly #begin: FileBeginMessage;
  readonly #expected: ManifestItem;
  readonly #writer: IncomingFileWriter;
  readonly #onProgress: TransferProgressHandler | undefined;
  readonly #chunks: Uint8Array[] = [];
  #nextIndex = 0;
  #nextOffset = 0;
  #finished = false;

  private constructor(
    options: IncomingFileTransferOptions,
    writer: IncomingFileWriter,
  ) {
    this.#begin = options.begin;
    this.#expected = options.expected;
    this.#writer = writer;
    this.#onProgress = options.onProgress;
  }

  /** Validates begin metadata before creating a partial destination. */
  static async start(options: IncomingFileTransferOptions): Promise<IncomingFileTransfer> {
    const { begin, expected } = options;
    if (begin.fileId !== expected.id || begin.displayName !== expected.displayName) {
      throw new TransferError("TRANSFER_FAILED", "File-begin metadata does not match the manifest.");
    }
    if (begin.size !== expected.size) {
      throw new TransferError("SIZE_MISMATCH", "File-begin size does not match the manifest.");
    }
    if (begin.hash !== expected.hash) {
      throw new TransferError("HASH_MISMATCH", "File-begin hash does not match the manifest.");
    }
    if (begin.size > MAX_BUFFERED_FILE_SIZE_BYTES) {
      throw new TransferError("TRANSFER_FAILED", "File exceeds the buffered transfer limit.");
    }

    let writer: IncomingFileWriter;
    try {
      writer = await options.sink.begin(expected);
    } catch (error) {
      throw new TransferError("DESTINATION_FAILED", "Could not create the destination.", {
        cause: error,
      });
    }
    const transfer = new IncomingFileTransfer(options, writer);
    transfer.#emitProgress();
    return transfer;
  }

  /** Writes the next exact index and byte range. */
  async write(message: FileChunkMessage): Promise<void> {
    if (this.#finished) {
      throw new TransferError("TRANSFER_FAILED", "Transfer has already finished.");
    }
    if (message.sessionId !== this.#begin.sessionId || message.fileId !== this.#begin.fileId) {
      return this.#reject(
        new TransferError("TRANSFER_FAILED", "Chunk belongs to another transfer."),
      );
    }
    if (message.index !== this.#nextIndex || message.offset !== this.#nextOffset) {
      return this.#reject(
        new TransferError("TRANSFER_FAILED", "Chunk index or byte range is not contiguous."),
      );
    }
    if (message.data.byteLength > this.#begin.chunkSize) {
      return this.#reject(
        new TransferError("TRANSFER_FAILED", "Chunk exceeds the declared chunk size."),
      );
    }
    if (this.#nextOffset + message.data.byteLength > this.#expected.size) {
      return this.#reject(
        new TransferError("SIZE_MISMATCH", "Received bytes exceed the manifest size."),
      );
    }

    const ownedChunk = message.data.slice();
    try {
      await this.#writer.write(ownedChunk);
    } catch (error) {
      return this.#reject(
        new TransferError("DESTINATION_FAILED", "Could not write to the destination.", {
          cause: error,
        }),
      );
    }
    if (this.#finished) return;
    this.#chunks.push(ownedChunk);
    this.#nextIndex += 1;
    this.#nextOffset += ownedChunk.byteLength;
    this.#emitProgress();
  }

  /** Verifies sender accounting and local SHA-256 before completing the writer. */
  async complete(message: FileEndMessage): Promise<void> {
    if (this.#finished) {
      throw new TransferError("TRANSFER_FAILED", "Transfer has already finished.");
    }
    if (message.sessionId !== this.#begin.sessionId || message.fileId !== this.#begin.fileId) {
      return this.#reject(
        new TransferError("TRANSFER_FAILED", "File-end belongs to another transfer."),
      );
    }
    if (
      this.#nextOffset !== this.#expected.size ||
      message.bytesSent !== this.#expected.size ||
      message.bytesSent !== this.#nextOffset
    ) {
      return this.#reject(
        new TransferError("SIZE_MISMATCH", "Final byte counts do not match the manifest."),
      );
    }
    if (message.hash !== this.#expected.hash) {
      return this.#reject(
        new TransferError("HASH_MISMATCH", "Sender hash does not match the manifest."),
      );
    }

    const received = concatenateChunks(this.#chunks, this.#nextOffset);
    const receivedHash = await sha256Hex(received);
    if (this.#finished) return;
    if (receivedHash !== this.#expected.hash) {
      return this.#reject(
        new TransferError("HASH_MISMATCH", "Received bytes do not match the manifest hash."),
      );
    }

    try {
      await this.#writer.complete();
    } catch (error) {
      return this.#reject(
        new TransferError("DESTINATION_FAILED", "Could not complete the destination.", {
          cause: error,
        }),
      );
    }
    this.#finished = true;
  }

  /** Aborts an incomplete destination. Repeated cancellation is safe. */
  async cancel(
    reason: unknown = new TransferError("TRANSFER_CANCELLED", "Transfer cancelled."),
  ): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    try {
      await this.#writer.abort(reason);
    } catch (error) {
      throw new TransferError("DESTINATION_FAILED", "Could not abort the destination.", {
        cause: error,
      });
    }
  }

  async #reject(error: TransferError): Promise<never> {
    if (!this.#finished) {
      this.#finished = true;
      try {
        await this.#writer.abort(error);
      } catch (abortError) {
        throw new TransferError("DESTINATION_FAILED", "Could not abort the destination.", {
          cause: abortError,
        });
      }
    }
    throw error;
  }

  #emitProgress(): void {
    emitTransferProgress(this.#onProgress, {
      fileId: this.#expected.id,
      transferredBytes: this.#nextOffset,
      totalBytes: this.#expected.size,
    });
  }
}
