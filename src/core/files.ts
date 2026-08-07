import type { ManifestItem } from "./manifest.js";

/**
 * Host-owned source metadata used to prepare a per-session manifest.
 *
 * The source ID stays on the sender. SenderSession replaces it with an opaque
 * manifest ID before anything can cross the transport boundary.
 */
export interface SourceItem {
  /** Host-local lookup key. This value must not be placed in a manifest. */
  readonly id: string;
  /** Safe receiver-facing name, without unrelated parent path information. */
  readonly displayName: string;
  /** Declared source length in bytes. */
  readonly size: number;
  /** Optional media type known by the source host. */
  readonly mimeType?: string;
  /** Declared SHA-256 hex; calculation and revalidation are Milestone 2 work. */
  readonly hash: string;
  /** Optional host revision used later to detect source mutation. */
  readonly sourceVersion?: string;
}

/**
 * Supplies file bytes without exposing Vault, browser File, or other host types.
 * The asynchronous byte stream deliberately avoids a whole-file buffer contract;
 * bounded reads and source-change checks are added around it in Milestone 2.
 */
export interface Source {
  /**
   * Lists the files selected for this session.
   *
   * @returns Host-local metadata. The session converts every `id` before disclosure.
   */
  list(): Promise<readonly SourceItem[]>;

  /**
   * Opens a fresh asynchronous byte stream for one host-local source ID.
   *
   * Implementations must not require callers to buffer the complete file.
   *
   * @param itemId - An `id` previously returned by `list()`.
   * @returns Bytes in source order. Implementations must not mutate a chunk after yielding it.
   * @throws When the item no longer exists or cannot be opened.
   */
  open(itemId: string): Promise<AsyncIterable<Uint8Array>>;
}

/** Receiver-facing metadata passed to a destination adapter. */
export type IncomingFileMeta = ManifestItem;

/**
 * Owns one in-progress destination write.
 *
 * Session shutdown may abort an active writer now. Integrity-gated completion
 * and cleanup after corrupt or incomplete transfers belong to Milestone 2.
 */
export interface IncomingFileWriter {
  /**
   * Appends bytes in transport order.
   *
   * The implementation must consume or copy `chunk` before the promise resolves.
   */
  write(chunk: Uint8Array): Promise<void>;

  /**
   * Finalises the destination after the caller has accepted the logical stream.
   * Milestone 2 makes that call conditional on byte-count and digest verification.
   */
  complete(): Promise<void>;

  /** Abandons the destination and cleans up incomplete output where possible. */
  abort(reason?: unknown): Promise<void>;
}

/** Creates host-owned destinations without exposing host storage to the domain. */
export interface Sink {
  /**
   * Begins an isolated destination write for one accepted manifest item.
   *
   * @returns The sole writer for this receive operation.
   * @throws When a safe destination cannot be created.
   */
  begin(meta: IncomingFileMeta): Promise<IncomingFileWriter>;
}
