import type { Source, SourceItem } from "../files.js";
import type { ManifestItem } from "../manifest.js";
import { ProtocolValidationError } from "../protocol/errors.js";
import type {
  CancelFileMessage,
  ConnectionRequestMessage,
  ErrorCode,
  ProtocolMessage,
  RequestFileMessage,
} from "../protocol/messages.js";
import { parseProtocolMessage } from "../protocol/validation.js";
import { BARROW_ALLEY_PROTOCOL_VERSION } from "../protocol/version.js";
import { TransferError } from "../transfer/errors.js";
import type { TransferProgressHandler } from "../transfer/progress.js";
import { sendFile } from "../transfer/sender.js";
import type { Transport } from "../../transport/transport.js";
import { SessionError } from "./errors.js";
import { transitionSenderState, type SenderState } from "./state.js";

export interface SenderSessionOptions {
  /** Opaque internal session ID; this is not the user-facing Pitch number. */
  readonly sessionId: string;
  /** Host-neutral provider for the files selected before the session starts. */
  readonly source: Source;
  /** Point-to-point capability owned exclusively by this sender session. */
  readonly transport: Transport;
  /** Internally configurable frame payload size. */
  readonly chunkSize?: number;
  /** Optional sender-side progress observer. */
  readonly onProgress?: TransferProgressHandler;
}

/**
 * Enforces admission and single-receiver access for one sender session.
 *
 * Source metadata may be prepared before a peer arrives, but only `accept()` can
 * disclose the manifest. All file requests are checked against both the accepted
 * peer and the per-session manifest mapping before source bytes are opened.
 */
export class SenderSession {
  readonly #sessionId: string;
  readonly #source: Source;
  readonly #transport: Transport;
  readonly #chunkSize: number | undefined;
  readonly #onProgress: TransferProgressHandler | undefined;
  readonly #knownPeers = new Set<string>();
  readonly #sourceItems = new Map<string, SourceItem>();
  readonly #unsubscribeMessage: () => void;
  #state: SenderState = "idle";
  #manifest: readonly ManifestItem[] = [];
  #pendingPeerId: string | undefined;
  #authorisedPeerId: string | undefined;
  #activeTransferAbort: AbortController | undefined;
  #activeTransferFileId: string | undefined;
  #activeTransferPromise: Promise<void> | undefined;
  #activeTransferPeerError: ErrorCode | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: SenderSessionOptions) {
    if (options.sessionId.length === 0) throw new Error("sessionId must not be empty.");
    this.#sessionId = options.sessionId;
    this.#source = options.source;
    this.#transport = options.transport;
    this.#chunkSize = options.chunkSize;
    this.#onProgress = options.onProgress;
    this.#unsubscribeMessage = this.#transport.onMessage(async (peerId, payload) => {
      await this.#receiveMessage(peerId, payload);
    });
  }

  /** Current explicit lifecycle state. UI adapters may observe but not set it. */
  get state(): SenderState {
    return this.#state;
  }

  /** Peer awaiting an explicit `accept()` or `deny()` decision, if any. */
  get pendingPeerId(): string | undefined {
    return this.#pendingPeerId;
  }

  /** Sole peer authorised to request manifest items, if acceptance has occurred. */
  get authorisedPeerId(): string | undefined {
    return this.#authorisedPeerId;
  }

  /**
   * Prepares source metadata locally and begins waiting for a connection request.
   * No peer message or manifest is sent by this operation.
   */
  async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new SessionError("INVALID_STATE", `Cannot start sender from ${this.#state}.`);
    }
    this.#transition("preparing");
    try {
      // Preparing locally is safe: no transport message is emitted from this path.
      const sourceItems = await this.#source.list();
      this.#prepareManifest(sourceItems);
      this.#transition("waiting-for-peer");
    } catch (error) {
      this.#transition("failed");
      throw error;
    }
  }

  /**
   * Accepts the pending peer, then sends acceptance before sending the manifest.
   *
   * @throws {SessionError} When no peer is awaiting approval.
   */
  async accept(): Promise<void> {
    if (this.#state !== "approval-pending" || this.#pendingPeerId === undefined) {
      throw new SessionError("NO_PENDING_PEER", "There is no peer awaiting approval.");
    }
    const peerId = this.#pendingPeerId;
    this.#pendingPeerId = undefined;
    this.#authorisedPeerId = peerId;
    this.#transition("connected");
    try {
      // Acceptance is deliberately a separate message and always precedes the
      // manifest. Keeping both sends here makes the disclosure boundary visible.
      await this.#transport.send(peerId, {
        type: "accept",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        sessionId: this.#sessionId,
      });
      await this.#transport.send(peerId, {
        type: "manifest",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        sessionId: this.#sessionId,
        items: this.#manifest,
      });
      this.#transition("serving");
    } catch (error) {
      this.#transition("failed");
      throw error;
    }
  }

  /**
   * Denies the pending peer without sending session or file metadata.
   *
   * @throws {SessionError} When no peer is awaiting approval.
   */
  async deny(): Promise<void> {
    if (this.#state !== "approval-pending" || this.#pendingPeerId === undefined) {
      throw new SessionError("NO_PENDING_PEER", "There is no peer awaiting approval.");
    }
    const peerId = this.#pendingPeerId;
    this.#pendingPeerId = undefined;
    try {
      await this.#transport.send(peerId, {
        type: "deny",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        reason: "denied",
      });
      this.#transition("waiting-for-peer");
    } catch (error) {
      this.#transition("failed");
      throw error;
    }
  }

  /** Closes transport-owned resources. Repeated calls return the same operation. */
  close(): Promise<void> {
    this.#closePromise ??= this.#performClose(true);
    return this.#closePromise;
  }

  #transition(next: SenderState): void {
    this.#state = transitionSenderState(this.#state, next);
  }

  #prepareManifest(sourceItems: readonly SourceItem[]): void {
    const sourceIds = new Set<string>();
    const manifestItems = sourceItems.map((sourceItem, index) => {
      if (sourceIds.has(sourceItem.id)) throw new Error(`Duplicate source item ID: ${sourceItem.id}.`);
      sourceIds.add(sourceItem.id);
      // A positional ID is opaque within this session: it reveals neither the
      // source path nor a stable host identifier, and is regenerated per session.
      const manifestId = `item-${String(index + 1)}`;
      this.#sourceItems.set(manifestId, sourceItem);
      const base = {
        id: manifestId,
        displayName: sourceItem.displayName,
        size: sourceItem.size,
        hash: sourceItem.hash,
      };
      return sourceItem.mimeType === undefined ? base : { ...base, mimeType: sourceItem.mimeType };
    });
    const validated = parseProtocolMessage({
      type: "manifest",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      items: manifestItems,
    });
    if (validated.type !== "manifest") throw new Error("Manifest validation returned another type.");
    this.#manifest = validated.items;
  }

  async #receiveMessage(peerId: string, payload: unknown): Promise<void> {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#knownPeers.add(peerId);
    let message: ProtocolMessage;
    try {
      message = parseProtocolMessage(payload);
    } catch (error) {
      await this.#rejectInvalidMessage(peerId, payload, error);
      return;
    }

    switch (message.type) {
      case "hello":
        // Hello may carry protocol and client-kind information before admission,
        // but deliberately causes no state change or metadata response.
        return;
      case "connection-request":
        await this.#receiveConnectionRequest(peerId, message);
        return;
      case "request-file":
        await this.#receiveFileRequest(peerId, message);
        return;
      case "cancel-file":
        await this.#receiveFileCancellation(peerId, message);
        return;
      case "cancel-session":
        if (peerId === this.#authorisedPeerId || peerId === this.#pendingPeerId) {
          await this.#performClose(false);
        }
        return;
      case "error":
        if (peerId === this.#authorisedPeerId) {
          this.#activeTransferPeerError = message.code;
          this.#activeTransferAbort?.abort(
            new TransferError("TRANSFER_FAILED", `Peer reported ${message.code}.`),
          );
          if (this.#state !== "transferring" && this.#state !== "failed") {
            this.#transition("failed");
          }
        }
        return;
      default:
        await this.#sendError(peerId, "INVALID_MESSAGE");
    }
  }

  async #receiveConnectionRequest(
    peerId: string,
    _message: ConnectionRequestMessage,
  ): Promise<void> {
    if (this.#state === "waiting-for-peer") {
      // The first pending peer owns the approval decision. Later peers receive a
      // busy denial and cannot displace either a pending or an accepted peer.
      this.#pendingPeerId = peerId;
      this.#transition("approval-pending");
      return;
    }
    if (this.#state === "approval-pending" && peerId === this.#pendingPeerId) return;
    await this.#transport.send(peerId, {
      type: "deny",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      reason: "busy",
    });
  }

  async #receiveFileRequest(peerId: string, message: RequestFileMessage): Promise<void> {
    // Treat an unauthorised or wrong-session request as unavailable without
    // confirming whether its guessed file ID exists.
    if (
      peerId !== this.#authorisedPeerId ||
      message.sessionId !== this.#sessionId ||
      (this.#state !== "serving" && this.#state !== "transferring")
    ) {
      await this.#sendError(peerId, "SESSION_CLOSED");
      return;
    }
    if (this.#state === "transferring") {
      await this.#sendError(peerId, "BUSY");
      return;
    }
    const sourceItem = this.#sourceItems.get(message.fileId);
    if (sourceItem === undefined) {
      await this.#sendError(peerId, "UNKNOWN_FILE");
      return;
    }

    const manifestItem = this.#manifest.find((item) => item.id === message.fileId);
    if (manifestItem === undefined) {
      this.#transition("failed");
      await this.#sendError(peerId, "TRANSFER_FAILED");
      return;
    }
    this.#transition("transferring");
    const abort = new AbortController();
    this.#activeTransferAbort = abort;
    this.#activeTransferFileId = message.fileId;
    this.#activeTransferPeerError = undefined;
    const transfer = sendFile({
      sessionId: this.#sessionId,
      fileId: message.fileId,
      sourceItem,
      manifestItem,
      source: this.#source,
      send: async (frame) => this.#transport.send(peerId, frame),
      ...(this.#chunkSize === undefined ? {} : { chunkSize: this.#chunkSize }),
      signal: abort.signal,
      ...(this.#onProgress === undefined ? {} : { onProgress: this.#onProgress }),
    });
    const completion = this.#settleFileTransfer(peerId, transfer);
    this.#activeTransferPromise = completion;
    try {
      await completion;
    } finally {
      if (this.#activeTransferPromise === completion) {
        this.#activeTransferAbort = undefined;
        this.#activeTransferFileId = undefined;
        this.#activeTransferPromise = undefined;
        this.#activeTransferPeerError = undefined;
      }
    }
  }

  async #settleFileTransfer(peerId: string, transfer: Promise<void>): Promise<void> {
    try {
      await transfer;
      this.#finishActiveTransfer("serving");
    } catch (error) {
      if (this.#activeTransferPeerError !== undefined) {
        this.#finishActiveTransfer("failed");
        return;
      }
      if (error instanceof TransferError && error.code === "TRANSFER_CANCELLED") {
        this.#finishActiveTransfer("serving");
        return;
      }
      if (this.#finishActiveTransfer("failed")) {
        await this.#sendError(peerId, transferErrorCode(error));
      }
    }
  }

  #finishActiveTransfer(next: "serving" | "failed"): boolean {
    if (this.#state !== "transferring") return false;
    this.#transition(next);
    return true;
  }

  async #receiveFileCancellation(peerId: string, message: CancelFileMessage): Promise<void> {
    if (
      peerId !== this.#authorisedPeerId ||
      message.sessionId !== this.#sessionId ||
      message.fileId !== this.#activeTransferFileId ||
      this.#state !== "transferring" ||
      this.#activeTransferAbort === undefined
    ) {
      return;
    }
    this.#activeTransferAbort.abort(
      new TransferError("TRANSFER_CANCELLED", `Transfer cancelled: ${message.fileId}.`),
    );
    try {
      await this.#activeTransferPromise;
    } catch {
      // The request handler maps the cancellation and restores the serving state.
    }
  }

  async #rejectInvalidMessage(peerId: string, payload: unknown, error: unknown): Promise<void> {
    if (
      error instanceof ProtocolValidationError &&
      error.code === "INCOMPATIBLE_PROTOCOL" &&
      isMessageType(payload, "connection-request")
    ) {
      await this.#transport.send(peerId, {
        type: "deny",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        reason: "incompatible",
      });
      return;
    }
    await this.#sendError(
      peerId,
      error instanceof ProtocolValidationError ? error.code : "INVALID_MESSAGE",
    );
  }

  async #sendError(peerId: string, code: ErrorCode): Promise<void> {
    await this.#transport.send(peerId, {
      type: "error",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      code,
    });
  }

  async #performClose(notifyPeers: boolean): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state !== "closing") this.#transition("closing");
    this.#activeTransferAbort?.abort(
      new TransferError("TRANSFER_CANCELLED", "Sender session closed."),
    );
    if (notifyPeers) {
      // Peer notification is best-effort; local resources must reach `closed`
      // even when a remote endpoint has already disappeared.
      await Promise.all(
        [...this.#knownPeers].map(async (peerId) => {
          try {
            await this.#transport.send(peerId, {
              type: "cancel-session",
              protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
              sessionId: this.#sessionId,
            });
          } catch {
            // A peer may already have disconnected; local cleanup must still complete.
          }
        }),
      );
    }
    try {
      await this.#activeTransferPromise;
    } catch {
      // Closing owns the final state even when the interrupted transfer failed.
    }
    this.#unsubscribeMessage();
    await this.#transport.close();
    this.#pendingPeerId = undefined;
    this.#authorisedPeerId = undefined;
    this.#transition("closed");
  }
}

function transferErrorCode(error: unknown): ErrorCode {
  return error instanceof TransferError ? error.code : "TRANSFER_FAILED";
}

function isMessageType(payload: unknown, type: string): boolean {
  return typeof payload === "object" && payload !== null && "type" in payload && payload.type === type;
}
