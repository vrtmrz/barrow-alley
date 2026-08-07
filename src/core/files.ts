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
  /** Declared SHA-256 hex revalidated against the transfer-time snapshot. */
  readonly hash: string;
  /** Optional host revision used later to detect source mutation. */
  readonly sourceVersion?: string;
}

/**
 * Supplies file bytes without exposing Vault, browser File, or other host types.
 * The initial Obsidian APIs expose complete binary files rather than partial
 * reads, so Milestone 2 deliberately uses one whole-file byte array here. The
 * transfer layer still splits that array into bounded wire chunks.
 */
export interface Source {
  /**
   * Lists the files selected for this session.
   *
   * @returns Host-local metadata. The session converts every `id` before disclosure.
   */
  list(): Promise<readonly SourceItem[]>;

  /**
   * Reads a fresh immutable snapshot for one host-local source ID.
   *
   * The returned array may contain the complete file. Implementations must not
   * mutate it after resolution because transfer-time size and hash checks are
   * performed against that snapshot.
   *
   * @param itemId - An `id` previously returned by `list()`.
   * @returns Complete file bytes in source order.
   * @throws When the item no longer exists or cannot be opened.
   */
  open(itemId: string): Promise<Uint8Array>;
}

/** Receiver-facing metadata passed to a destination adapter. */
export type IncomingFileMeta = ManifestItem;

/**
 * Owns one in-progress destination write.
 *
 * Session shutdown or an integrity failure aborts the active writer. Completion
 * is called only after range, size, and SHA-256 verification succeeds.
 */
export interface IncomingFileWriter {
  /**
   * Appends bytes in transport order.
   *
   * The implementation must consume or copy `chunk` before the promise resolves.
   */
  write(chunk: Uint8Array): Promise<void>;

  /**
   * Finalises the destination after byte-count and digest verification succeeds.
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
