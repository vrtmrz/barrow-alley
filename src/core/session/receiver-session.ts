import type { Sink } from "../files.js";
import type { ManifestItem } from "../manifest.js";
import { ProtocolValidationError } from "../protocol/errors.js";
import type {
    ClientKind,
    ErrorCode,
    FileBeginMessage,
    FileChunkMessage,
    FileEndMessage,
    ProtocolMessage,
} from "../protocol/messages.js";
import { parseProtocolMessage } from "../protocol/validation.js";
import { BARROW_ALLEY_PROTOCOL_VERSION } from "../protocol/version.js";
import { TransferError } from "../transfer/errors.js";
import type { TransferProgressHandler } from "../transfer/progress.js";
import { IncomingFileTransfer } from "../transfer/receiver.js";
import type { Transport } from "../../transport/transport.js";
import { SessionError } from "./errors.js";
import { type ReceiverState, type ReceiverStateHandler, transitionReceiverState } from "./state.js";

export interface ReceiverSessionOptions {
    /** Host category announced during admission; it grants no authority. */
    readonly clientKind: ClientKind;
    /** Host-neutral destination capability for accepted incoming files. */
    readonly sink: Sink;
    /** Point-to-point capability owned exclusively by this receiver session. */
    readonly transport: Transport;
    /** Optional receiver-side progress observer. */
    readonly onProgress?: TransferProgressHandler;
    /** Optional presentation observer for valid lifecycle transitions. */
    readonly onStateChange?: ReceiverStateHandler;
}

/**
 * Enforces receiver admission and manifest-scoped file selection.
 *
 * No manifest is exposed while awaiting approval. After acceptance, callers can
 * request only IDs present in that manifest, and only one destination writer may
 * be active for the session.
 */
export class ReceiverSession {
    readonly #clientKind: ClientKind;
    readonly #sink: Sink;
    readonly #transport: Transport;
    readonly #onProgress: TransferProgressHandler | undefined;
    readonly #onStateChange: ReceiverStateHandler | undefined;
    readonly #unsubscribeMessage: () => void;
    #state: ReceiverState = "idle";
    #senderPeerId: string | undefined;
    #sessionId: string | undefined;
    #manifest: readonly ManifestItem[] | undefined;
    #activeFileId: string | undefined;
    #activeTransfer: IncomingFileTransfer | undefined;
    #cancelledTransfer: { readonly sessionId: string; readonly fileId: string } | undefined;
    #peerError: ErrorCode | undefined;
    #closePromise: Promise<void> | undefined;

    constructor(options: ReceiverSessionOptions) {
        this.#clientKind = options.clientKind;
        this.#sink = options.sink;
        this.#transport = options.transport;
        this.#onProgress = options.onProgress;
        this.#onStateChange = options.onStateChange;
        this.#unsubscribeMessage = this.#transport.onMessage(async (peerId, payload) => {
            await this.#receiveMessage(peerId, payload);
        });
    }

    /** Current explicit lifecycle state. UI adapters may observe but not set it. */
    get state(): ReceiverState {
        return this.#state;
    }

    /** Accepted manifest, or `undefined` until both acceptance and validation occur. */
    get manifest(): readonly ManifestItem[] | undefined {
        return this.#manifest;
    }

    /** Last stable error code received from the sender, if any. */
    get peerError(): ErrorCode | undefined {
        return this.#peerError;
    }

    /**
     * Sends a metadata-free admission request to one sender peer.
     *
     * @throws {SessionError} When this session has already left `idle`.
     */
    async connect(senderPeerId: string): Promise<void> {
        if (this.#state !== "idle") {
            throw new SessionError("INVALID_STATE", `Cannot connect receiver from ${this.#state}.`);
        }
        if (senderPeerId.length === 0) throw new Error("senderPeerId must not be empty.");
        this.#senderPeerId = senderPeerId;
        this.#transition("connecting");
        this.#transition("awaiting-approval");
        try {
            await this.#transport.send(senderPeerId, {
                type: "connection-request",
                protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
                clientKind: this.#clientKind,
            });
        } catch (error) {
            this.#transition("failed");
            throw error;
        }
    }

    /**
     * Requests one ID from the validated manifest.
     *
     * @throws {SessionError} Before browsing, for an unknown ID, or after peer rejection.
     */
    async requestFile(fileId: string): Promise<void> {
        if (
            this.#state !== "browsing" ||
            this.#manifest === undefined ||
            this.#sessionId === undefined ||
            this.#senderPeerId === undefined
        ) {
            throw new SessionError("INVALID_STATE", "A file can be requested only while browsing.");
        }
        if (!this.#manifest.some((item) => item.id === fileId)) {
            // Reject locally so an arbitrary caller cannot turn this API into a probe
            // for sender-side identifiers outside the disclosed manifest.
            throw new SessionError("UNKNOWN_FILE", `Unknown manifest item: ${fileId}.`);
        }
        this.#peerError = undefined;
        this.#cancelledTransfer = undefined;
        this.#activeFileId = fileId;
        this.#transition("receiving");
        try {
            await this.#transport.send(this.#senderPeerId, {
                type: "request-file",
                protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
                sessionId: this.#sessionId,
                fileId,
            });
        } catch (error) {
            this.#transition("failed");
            throw error;
        }
        const peerError = this.peerError;
        if (peerError !== undefined) {
            throw new SessionError("PEER_ERROR", `The sender rejected the request: ${peerError}.`);
        }
    }

    /** Cancels the active file while preserving the accepted session and manifest. */
    async cancelFile(): Promise<void> {
        if (
            this.#state !== "receiving" ||
            this.#sessionId === undefined ||
            this.#senderPeerId === undefined ||
            this.#activeFileId === undefined
        ) {
            throw new SessionError(
                "INVALID_STATE",
                "A file can be cancelled only while receiving.",
            );
        }
        const sessionId = this.#sessionId;
        const fileId = this.#activeFileId;
        const transfer = this.#activeTransfer;
        this.#cancelledTransfer = { sessionId, fileId };
        this.#activeTransfer = undefined;
        this.#activeFileId = undefined;
        this.#transition("browsing");

        // Start peer cancellation before awaiting destination cleanup. In-memory
        // delivery then trips the sender's AbortSignal before another frame is sent.
        const notify = this.#transport.send(this.#senderPeerId, {
            type: "cancel-file",
            protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
            sessionId,
            fileId,
        });
        const [cleanupResult, notifyResult] = await Promise.allSettled([
            transfer?.cancel() ?? Promise.resolve(),
            notify,
        ]);
        if (cleanupResult.status === "rejected") {
            this.#peerError = "DESTINATION_FAILED";
            this.#transition("failed");
            throw cleanupResult.reason;
        }
        if (notifyResult.status === "rejected") {
            this.#transition("failed");
            throw notifyResult.reason;
        }
    }

    /** Closes transport and destination resources. Repeated calls are safe. */
    close(): Promise<void> {
        return this.#requestClose(true);
    }

    #transition(next: ReceiverState): void {
        this.#state = transitionReceiverState(this.#state, next);
        try {
            this.#onStateChange?.(this.#state);
        } catch {
            // Presentation observers cannot alter the session lifecycle.
        }
    }

    async #receiveMessage(peerId: string, payload: unknown): Promise<void> {
        if (
            peerId !== this.#senderPeerId || this.#state === "closing" || this.#state === "closed"
        ) {
            return;
        }
        let message: ProtocolMessage;
        try {
            message = parseProtocolMessage(payload);
        } catch (error) {
            if (this.#state === "denied" || this.#state === "failed") return;
            this.#peerError = error instanceof ProtocolValidationError
                ? error.code
                : "INVALID_MESSAGE";
            try {
                await this.#activeTransfer?.cancel(error);
            } catch {
                this.#peerError = "DESTINATION_FAILED";
            }
            this.#activeTransfer = undefined;
            this.#activeFileId = undefined;
            this.#transition("failed");
            return;
        }

        switch (message.type) {
            case "accept":
                if (this.#state !== "awaiting-approval") return;
                this.#sessionId = message.sessionId;
                // Acceptance authorises manifest disclosure, but does not itself imply
                // that a valid manifest has arrived.
                this.#transition("loading-manifest");
                return;
            case "manifest":
                if (this.#state !== "loading-manifest" || message.sessionId !== this.#sessionId) {
                    return;
                }
                this.#manifest = message.items;
                this.#transition("browsing");
                return;
            case "file-begin":
                await this.#receiveFileBegin(message);
                return;
            case "file-chunk":
                await this.#receiveFileChunk(message);
                return;
            case "file-end":
                await this.#receiveFileEnd(message);
                return;
            case "cancel-file":
                if (this.#matchesActive(message.sessionId, message.fileId)) {
                    try {
                        await this.#activeTransfer?.cancel();
                    } catch {
                        this.#peerError = "DESTINATION_FAILED";
                        this.#activeTransfer = undefined;
                        this.#activeFileId = undefined;
                        this.#transition("failed");
                        return;
                    }
                    this.#activeTransfer = undefined;
                    this.#activeFileId = undefined;
                    this.#transition("browsing");
                }
                return;
            case "deny":
                if (this.#state === "awaiting-approval") this.#transition("denied");
                return;
            case "cancel-session":
                if (
                    message.sessionId === undefined ||
                    this.#sessionId === undefined ||
                    message.sessionId === this.#sessionId
                ) {
                    await this.#requestClose(false);
                }
                return;
            case "error":
                if (this.#state === "denied" || this.#state === "failed") return;
                this.#peerError = message.code;
                try {
                    await this.#activeTransfer?.cancel(
                        new TransferError("TRANSFER_FAILED", `Sender reported ${message.code}.`),
                    );
                } catch {
                    this.#peerError = "DESTINATION_FAILED";
                }
                this.#activeTransfer = undefined;
                this.#activeFileId = undefined;
                this.#transition("failed");
                return;
            default:
                return;
        }
    }

    async #receiveFileBegin(message: FileBeginMessage): Promise<void> {
        if (this.#isCancelled(message.sessionId, message.fileId)) return;
        if (
            !this.#matchesActive(message.sessionId, message.fileId) || this.#manifest === undefined
        ) {
            return;
        }
        const meta = this.#manifest.find((item) => item.id === message.fileId);
        if (meta === undefined) return;
        try {
            this.#activeTransfer = await IncomingFileTransfer.start({
                begin: message,
                expected: meta,
                sink: this.#sink,
                ...(this.#onProgress === undefined ? {} : { onProgress: this.#onProgress }),
            });
        } catch (error) {
            await this.#failTransfer(error);
        }
    }

    async #receiveFileChunk(message: FileChunkMessage): Promise<void> {
        if (this.#isCancelled(message.sessionId, message.fileId)) return;
        if (
            !this.#matchesActive(message.sessionId, message.fileId) ||
            this.#activeTransfer === undefined
        ) {
            return;
        }
        try {
            await this.#activeTransfer.write(message);
        } catch (error) {
            await this.#failTransfer(error);
        }
    }

    async #receiveFileEnd(message: FileEndMessage): Promise<void> {
        if (this.#isCancelled(message.sessionId, message.fileId)) return;
        if (
            !this.#matchesActive(message.sessionId, message.fileId) ||
            this.#activeTransfer === undefined
        ) {
            return;
        }
        const transfer = this.#activeTransfer;
        try {
            await transfer.complete(message);
            if (this.#state !== "receiving" || this.#activeTransfer !== transfer) return;
            this.#activeTransfer = undefined;
            this.#activeFileId = undefined;
            this.#transition("browsing");
        } catch (error) {
            await this.#failTransfer(error);
        }
    }

    async #failTransfer(error: unknown): Promise<void> {
        const transferError = error instanceof TransferError
            ? error
            : new TransferError("TRANSFER_FAILED", "Incoming transfer failed.", { cause: error });
        let reportedError = transferError;
        try {
            await this.#activeTransfer?.cancel(transferError);
        } catch (error) {
            reportedError = error instanceof TransferError
                ? error
                : new TransferError("DESTINATION_FAILED", "Could not abort the destination.", {
                    cause: error,
                });
        }
        this.#activeTransfer = undefined;
        this.#activeFileId = undefined;
        this.#peerError = reportedError.code;
        if (this.#state === "receiving") this.#transition("failed");
        if (this.#senderPeerId !== undefined) {
            await this.#transport.send(this.#senderPeerId, {
                type: "error",
                protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
                code: reportedError.code,
            });
        }
    }

    #matchesActive(sessionId: string, fileId: string): boolean {
        return (
            this.#state === "receiving" &&
            sessionId === this.#sessionId &&
            fileId === this.#activeFileId
        );
    }

    #isCancelled(sessionId: string, fileId: string): boolean {
        return (
            this.#cancelledTransfer?.sessionId === sessionId &&
            this.#cancelledTransfer.fileId === fileId
        );
    }

    #requestClose(notifySender: boolean): Promise<void> {
        // Local UI close and a peer cancellation can arrive in the same task turn.
        // Whichever starts first owns the one cleanup operation and all callers
        // observe that promise instead of racing a second terminal transition.
        this.#closePromise ??= this.#performClose(notifySender);
        return this.#closePromise;
    }

    async #performClose(notifySender: boolean): Promise<void> {
        if (this.#state === "closed") return;
        if (this.#state !== "closing") this.#transition("closing");
        if (notifySender && this.#senderPeerId !== undefined) {
            try {
                await this.#transport.send(this.#senderPeerId, {
                    type: "cancel-session",
                    protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
                    ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
                });
            } catch {
                // The sender may already have closed; local cleanup must still complete.
            }
        }
        let cleanupError: unknown;
        try {
            await this.#activeTransfer?.cancel(new Error("Session closed."));
        } catch (error) {
            cleanupError = error;
        }
        this.#activeTransfer = undefined;
        this.#unsubscribeMessage();
        await this.#transport.close();
        this.#activeFileId = undefined;
        this.#transition("closed");
        if (cleanupError !== undefined) {
            throw cleanupError instanceof Error
                ? cleanupError
                : new Error("The receiver could not clean up its active transfer.", {
                    cause: cleanupError,
                });
        }
    }
}
