/** Default payload size for one file chunk. It is an implementation setting, not protocol law. */
export const DEFAULT_TRANSFER_CHUNK_SIZE_BYTES = 64 * 1024;

/** Largest individual chunk accepted from an untrusted peer. */
export const MAX_TRANSFER_CHUNK_SIZE_BYTES = 1024 * 1024;

/**
 * Initial whole-file buffering ceiling.
 *
 * Obsidian exposes binary reads as complete `ArrayBuffer` values. Keeping this
 * explicit prevents a peer or source adapter from causing unbounded buffering
 * while that host limitation is in force.
 */
export const MAX_BUFFERED_FILE_SIZE_BYTES = 100 * 1024 * 1024;
