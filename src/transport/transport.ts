/** Logical file stream delivered after an authorised manifest request. */
export interface IncomingTransfer {
  /** Internal session ID established by `AcceptMessage`. */
  readonly sessionId: string;
  /** Opaque ID from the accepted manifest. */
  readonly fileId: string;
  /** Ordered bytes; no index, range, or digest guarantee exists until Milestone 2. */
  readonly chunks: AsyncIterable<Uint8Array>;
}

/**
 * Receives an untrusted control payload from one peer.
 *
 * @param peerId - Transport identity of the immediate sender.
 * @param payload - Value which must be validated before domain use.
 */
export type MessageHandler = (peerId: string, payload: unknown) => void | Promise<void>;

/**
 * Receives one logical byte stream from one peer.
 *
 * @param peerId - Transport identity checked against session authorisation.
 * @param transfer - Session-scoped stream metadata and ordered bytes.
 */
export type TransferHandler = (peerId: string, transfer: IncomingTransfer) => void | Promise<void>;

/**
 * Narrow point-to-point boundary used by host-neutral sessions.
 *
 * `send` carries untrusted control payloads which the receiving session validates.
 * `sendTransfer` is a logical byte stream, not a wire protocol: Milestone 2 will
 * define framing, backpressure, progress, and integrity without changing session
 * admission rules. A Trystero implementation is deferred to Milestone 3.
 */
export interface Transport {
  /** Stable identity of the local endpoint within this transport instance. */
  readonly peerId: string;

  /**
   * Queues a control payload for one peer.
   *
   * Implementations must preserve call order for payloads sent sequentially to
   * the same peer. Resolution does not imply application-level acknowledgement.
   */
  send(peerId: string, payload: unknown): Promise<void>;

  /**
   * Consumes and delivers one logical stream to an authorised peer.
   * Resolution does not imply byte-count or digest verification.
   */
  sendTransfer(peerId: string, transfer: IncomingTransfer): Promise<void>;

  /**
   * Registers a control-message listener.
   *
   * @returns An idempotent function which unregisters this listener.
   */
  onMessage(handler: MessageHandler): () => void;

  /**
   * Registers the session's exclusive incoming-transfer consumer.
   *
   * @returns An idempotent function which unregisters this listener.
   */
  onTransfer(handler: TransferHandler): () => void;

  /** Releases endpoint resources and rejects later sends. Must be idempotent. */
  close(): Promise<void>;
}
