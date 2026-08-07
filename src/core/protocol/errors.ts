/**
 * Local result of parsing an untrusted control payload at the protocol boundary.
 *
 * `INVALID_MESSAGE` means that the payload cannot be reconstructed as a known,
 * well-formed message. `INCOMPATIBLE_PROTOCOL` is reserved for a syntactically
 * valid integer version which this implementation does not support. This local
 * classification is not itself a wire response: the session decides whether to
 * send an `ErrorMessage`, use an admission `DenyMessage`, or fail locally.
 */
export type ProtocolValidationErrorCode = "INVALID_MESSAGE" | "INCOMPATIBLE_PROTOCOL";

/**
 * Reports why an untrusted peer payload was rejected at the parsing boundary.
 *
 * The error message is diagnostic text for the local implementation and must
 * not be forwarded to a peer as user-facing or protocol text.
 */
export class ProtocolValidationError extends Error {
  /** Stable local category which a session may map to a protocol response. */
  readonly code: ProtocolValidationErrorCode;

  /**
   * @param code Stable reason for rejecting the payload.
   * @param message Local diagnostic detail; it is not part of the wire protocol.
   */
  constructor(code: ProtocolValidationErrorCode, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}
