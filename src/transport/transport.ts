/**
 * Receives an untrusted control or file-frame payload from one peer.
 *
 * @param peerId - Transport identity of the immediate sender.
 * @param payload - Value which must be validated before domain use.
 */
export type MessageHandler = (peerId: string, payload: unknown) => void | Promise<void>;

/**
 * Narrow point-to-point boundary used by host-neutral sessions.
 *
 * `send` carries both control and bounded file frames. The receiving session
 * validates every payload. A Trystero implementation is deferred to Milestone 3.
 */
export interface Transport {
  /** Stable identity of the local endpoint within this transport instance. */
  readonly peerId: string;

  /**
   * Queues one control or bounded file-frame payload for a peer.
   *
   * Implementations must preserve sequential call order and apply transport-level
   * backpressure before resolving. Resolution means that another bounded frame
   * may be offered; it does not imply application-level acknowledgement.
   */
  send(peerId: string, payload: unknown): Promise<void>;

  /**
   * Registers a control-message listener.
   *
   * @returns An idempotent function which unregisters this listener.
   */
  onMessage(handler: MessageHandler): () => void;

  /** Releases endpoint resources and rejects later sends. Must be idempotent. */
  close(): Promise<void>;
}
