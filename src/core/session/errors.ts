export type SessionErrorCode =
  | "INVALID_STATE"
  | "NO_PENDING_PEER"
  | "UNKNOWN_FILE"
  | "PEER_ERROR";

export class SessionError extends Error {
  readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}
