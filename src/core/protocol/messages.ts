import type { ManifestItem } from "../manifest.js";

// These are Milestone 1 control-plane messages. Wire-level file begin/chunk/end
// frames are intentionally absent until Milestone 2 defines their accounting
// and integrity rules as one coherent contract.
/** Peer host category used for compatibility and user-facing context, not authority. */
export type ClientKind = "obsidian" | "browser";

/** Sender response to an admission request; none of these reasons disclose files. */
export type DenyReason = "denied" | "busy" | "incompatible";

/**
 * Stable machine-readable control error reported across the peer boundary.
 *
 * The codes describe what the receiver of a request may safely learn, rather
 * than exposing internal exception text:
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
 */
export type ErrorCode =
  | "INVALID_MESSAGE"
  | "INCOMPATIBLE_PROTOCOL"
  | "BUSY"
  | "UNKNOWN_FILE"
  | "SESSION_CLOSED";

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

/** Every control-plane payload accepted by the Milestone 1 session layer. */
export type ProtocolMessage =
  | HelloMessage
  | ConnectionRequestMessage
  | AcceptMessage
  | DenyMessage
  | ManifestMessage
  | RequestFileMessage
  | CancelSessionMessage
  | ErrorMessage;
