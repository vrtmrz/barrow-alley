import type { IncomingFileWriter, Sink } from "../files.js";
import type { ManifestItem } from "../manifest.js";
import { ProtocolValidationError } from "../protocol/errors.js";
import type { ClientKind, ErrorCode, ProtocolMessage } from "../protocol/messages.js";
import { parseProtocolMessage } from "../protocol/validation.js";
import { BARROW_ALLEY_PROTOCOL_VERSION } from "../protocol/version.js";
import type { IncomingTransfer, Transport } from "../../transport/transport.js";
import { SessionError } from "./errors.js";
import { transitionReceiverState, type ReceiverState } from "./state.js";

export interface ReceiverSessionOptions {
  /** Host category announced during admission; it grants no authority. */
  readonly clientKind: ClientKind;
  /** Host-neutral destination capability for accepted incoming files. */
  readonly sink: Sink;
  /** Point-to-point capability owned exclusively by this receiver session. */
  readonly transport: Transport;
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
  readonly #unsubscribeMessage: () => void;
  readonly #unsubscribeTransfer: () => void;
  #state: ReceiverState = "idle";
  #senderPeerId: string | undefined;
  #sessionId: string | undefined;
  #manifest: readonly ManifestItem[] | undefined;
  #activeFileId: string | undefined;
  #activeWriter: IncomingFileWriter | undefined;
  #peerError: ErrorCode | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: ReceiverSessionOptions) {
    this.#clientKind = options.clientKind;
    this.#sink = options.sink;
    this.#transport = options.transport;
    this.#unsubscribeMessage = this.#transport.onMessage(async (peerId, payload) => {
      await this.#receiveMessage(peerId, payload);
    });
    this.#unsubscribeTransfer = this.#transport.onTransfer(async (peerId, transfer) => {
      await this.#receiveTransfer(peerId, transfer);
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
    if (this.#peerError !== undefined) {
      throw new SessionError("PEER_ERROR", `The sender rejected the request: ${this.#peerError}.`);
    }
  }

  /** Closes transport and destination resources. Repeated calls are safe. */
  close(): Promise<void> {
    this.#closePromise ??= this.#performClose(true);
    return this.#closePromise;
  }

  #transition(next: ReceiverState): void {
    this.#state = transitionReceiverState(this.#state, next);
  }

  async #receiveMessage(peerId: string, payload: unknown): Promise<void> {
    if (peerId !== this.#senderPeerId || this.#state === "closing" || this.#state === "closed") {
      return;
    }
    let message: ProtocolMessage;
    try {
      message = parseProtocolMessage(payload);
    } catch (error) {
      if (this.#state === "denied" || this.#state === "failed") return;
      this.#peerError =
        error instanceof ProtocolValidationError ? error.code : "INVALID_MESSAGE";
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
        if (this.#state !== "loading-manifest" || message.sessionId !== this.#sessionId) return;
        this.#manifest = message.items;
        this.#transition("browsing");
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
          await this.#performClose(false);
        }
        return;
      case "error":
        if (this.#state === "denied" || this.#state === "failed") return;
        this.#peerError = message.code;
        this.#transition("failed");
        return;
      default:
        return;
    }
  }

  async #receiveTransfer(peerId: string, transfer: IncomingTransfer): Promise<void> {
    // The logical data plane is accepted only for the selected manifest item
    // from the accepted sender. Byte-range and digest checks arrive in Milestone 2.
    if (
      peerId !== this.#senderPeerId ||
      this.#state !== "receiving" ||
      transfer.sessionId !== this.#sessionId ||
      transfer.fileId !== this.#activeFileId ||
      this.#manifest === undefined
    ) {
      throw new SessionError("INVALID_STATE", "Unexpected incoming file transfer.");
    }
    const meta = this.#manifest.find((item) => item.id === transfer.fileId);
    if (meta === undefined) throw new SessionError("UNKNOWN_FILE", "Transfer item is not in manifest.");

    this.#activeWriter = await this.#sink.begin(meta);
    try {
      for await (const chunk of transfer.chunks) await this.#activeWriter.write(chunk);
      await this.#activeWriter.complete();
      this.#activeWriter = undefined;
      this.#activeFileId = undefined;
      this.#transition("browsing");
    } catch (error) {
      this.#transition("failed");
      throw error;
    }
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
    if (this.#activeWriter !== undefined) {
      // Lifecycle cleanup is required now; deciding whether partial bytes can be
      // committed after transfer failures remains an integrity-layer decision.
      await this.#activeWriter.abort(new Error("Session closed."));
      this.#activeWriter = undefined;
    }
    this.#unsubscribeMessage();
    this.#unsubscribeTransfer();
    await this.#transport.close();
    this.#activeFileId = undefined;
    this.#transition("closed");
  }
}
