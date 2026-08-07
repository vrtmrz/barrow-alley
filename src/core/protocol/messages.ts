import type { ManifestItem } from "../manifest.js";

// Admission and session-control messages were established in Milestone 1.
// Milestone 2 adds bounded file frames without changing the admission boundary.
/** Peer host category used for compatibility and user-facing context, not authority. */
export type ClientKind = "obsidian" | "browser";

/** Sender response to an admission request; none of these reasons disclose files. */
export type DenyReason = "denied" | "busy" | "incompatible";

/**
 * Stable machine-readable control error reported across the peer boundary.
 *
 * The codes describe what the other peer may safely learn, rather than exposing
 * internal exception text:
 *
 * - `INVALID_MESSAGE` — the payload is structurally invalid, contains an
 *   unsupported value in a validated field or an unknown message type, or is a
 *   recognised message type which the receiving role does not accept in that
 *   context.
 * - `INCOMPATIBLE_PROTOCOL` — `protocolVersion` is a valid integer, but this
 *   implementation does not support it. A missing or malformed version is an
 *   `INVALID_MESSAGE` instead.
 * - `BUSY` — the accepted peer requested another file while one transfer was
 *   already active. A competing admission request uses `DenyReason` `busy`
 *   instead because admission has not yet succeeded.
 * - `UNKNOWN_FILE` — the accepted peer requested an ID which is absent from the
 *   manifest disclosed to it.
 * - `SESSION_CLOSED` — the requested session is unavailable to that peer. This
 *   deliberately also covers a wrong session ID, an unauthorised peer, and a
 *   sender state which cannot serve files, so the response does not confirm
 *   whether a guessed file ID exists.
 * - `SOURCE_CHANGED` — the sender's current bytes no longer match the accepted
 *   manifest, so the pitch must be set up again.
 * - `TRANSFER_CANCELLED` — the active file transfer was intentionally stopped.
 * - `TRANSFER_FAILED` — framing, range accounting, or another transfer
 *   invariant failed without a more specific safe code.
 * - `SIZE_MISMATCH` — declared, sent, and received byte counts disagree.
 * - `HASH_MISMATCH` — the sender, manifest, or locally calculated SHA-256 values
 *   disagree.
 * - `DESTINATION_FAILED` — the receiver could not create, write, complete, or
 *   clean up its destination.
 */
export type ErrorCode =
  | "INVALID_MESSAGE"
  | "INCOMPATIBLE_PROTOCOL"
  | "BUSY"
  | "UNKNOWN_FILE"
  | "SESSION_CLOSED"
  | "SOURCE_CHANGED"
  | "TRANSFER_CANCELLED"
  | "TRANSFER_FAILED"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "DESTINATION_FAILED";

interface VersionedMessage {
  /** Protocol version validated before any message-specific field is consumed. */
  readonly protocolVersion: number;
}

/** Pre-admission compatibility information which causes no authorisation change. */
export interface HelloMessage extends VersionedMessage {
  readonly type: "hello";
  readonly clientKind: ClientKind;
}

/** Requests sender approval without including or requesting file metadata. */
export interface ConnectionRequestMessage extends VersionedMessage {
  readonly type: "connection-request";
  readonly clientKind: ClientKind;
}

/** Authorises exactly one peer for the named internal session. */
export interface AcceptMessage extends VersionedMessage {
  readonly type: "accept";
  readonly sessionId: string;
}

/** Rejects an admission request without disclosing a session ID or file details. */
export interface DenyMessage extends VersionedMessage {
  readonly type: "deny";
  readonly reason?: DenyReason;
}

/** File metadata sent only after the same peer has received `AcceptMessage`. */
export interface ManifestMessage extends VersionedMessage {
  readonly type: "manifest";
  readonly sessionId: string;
  readonly items: readonly ManifestItem[];
}

/** Requests one opaque ID from the accepted session manifest. */
export interface RequestFileMessage extends VersionedMessage {
  readonly type: "request-file";
  readonly sessionId: string;
  readonly fileId: string;
}

/** Starts one authorised, manifest-scoped file transfer. */
export interface FileBeginMessage extends VersionedMessage {
  readonly type: "file-begin";
  readonly sessionId: string;
  readonly fileId: string;
  readonly displayName: string;
  readonly size: number;
  readonly hash: string;
  /** Maximum payload bytes in each following `FileChunkMessage`. */
  readonly chunkSize: number;
}

/** Carries one exact, ordered byte range for the active file. */
export interface FileChunkMessage extends VersionedMessage {
  readonly type: "file-chunk";
  readonly sessionId: string;
  readonly fileId: string;
  readonly index: number;
  readonly offset: number;
  readonly data: Uint8Array;
}

/** Reports the sender's final byte count and hash for receiver verification. */
export interface FileEndMessage extends VersionedMessage {
  readonly type: "file-end";
  readonly sessionId: string;
  readonly fileId: string;
  readonly bytesSent: number;
  readonly hash: string;
}

/** Cancels only the named active file while leaving the accepted session open. */
export interface CancelFileMessage extends VersionedMessage {
  readonly type: "cancel-file";
  readonly sessionId: string;
  readonly fileId: string;
}

/** Requests lifecycle shutdown; it does not represent per-file cancellation. */
export interface CancelSessionMessage extends VersionedMessage {
  readonly type: "cancel-session";
  // A receiver awaiting approval does not know the accepted session ID yet.
  readonly sessionId?: string;
}

/** Reports a stable control failure without forwarding arbitrary peer text. */
export interface ErrorMessage extends VersionedMessage {
  readonly type: "error";
  readonly code: ErrorCode;
}

/** Every peer payload accepted by the host-neutral session layer. */
export type ProtocolMessage =
  | HelloMessage
  | ConnectionRequestMessage
  | AcceptMessage
  | DenyMessage
  | ManifestMessage
  | RequestFileMessage
  | FileBeginMessage
  | FileChunkMessage
  | FileEndMessage
  | CancelFileMessage
  | CancelSessionMessage
  | ErrorMessage;
