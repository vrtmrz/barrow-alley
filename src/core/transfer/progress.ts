/** Monotonic progress for one requested manifest item. */
export interface TransferProgress {
    /** Opaque ID from the accepted session manifest. */
    readonly fileId: string;
    /** Bytes successfully sent or written so far. */
    readonly transferredBytes: number;
    /** Declared manifest size used as the progress denominator. */
    readonly totalBytes: number;
}

/** Observer used by UI adapters; throwing from an observer does not fail a transfer. */
export type TransferProgressHandler = (progress: TransferProgress) => void;

export function emitTransferProgress(
    handler: TransferProgressHandler | undefined,
    progress: TransferProgress,
): void {
    try {
        handler?.(progress);
    } catch {
        // Presentation observers are not part of the integrity or lifecycle contract.
    }
}
