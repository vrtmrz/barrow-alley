export type TransferErrorCode =
  | "SOURCE_CHANGED"
  | "TRANSFER_CANCELLED"
  | "TRANSFER_FAILED"
  | "SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "DESTINATION_FAILED";

/** Stable failure raised by host-neutral transfer accounting and integrity checks. */
export class TransferError extends Error {
  readonly code: TransferErrorCode;

  constructor(code: TransferErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransferError";
    this.code = code;
  }
}
