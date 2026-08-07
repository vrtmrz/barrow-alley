import type { MessageHandler, Transport } from "./transport.js";

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export interface InMemoryMessageContext {
  readonly senderPeerId: string;
  readonly recipientPeerId: string;
  readonly payload: unknown;
}

export interface InMemoryTransportNetworkOptions {
  /** Deterministic fault-injection boundary used by protocol integration tests. */
  readonly transformMessage?: (context: InMemoryMessageContext) => unknown;
}

/**
 * Owns isolated endpoints for deterministic session integration tests.
 *
 * It models peer identity, framed-message routing, and closure only. It
 * intentionally does not simulate Trystero, network timing, or DataChannel
 * buffering.
 */
export class InMemoryTransportNetwork {
  readonly #endpoints = new Map<string, InMemoryTransport>();
  readonly #transformMessage: ((context: InMemoryMessageContext) => unknown) | undefined;

  constructor(options: InMemoryTransportNetworkOptions = {}) {
    this.#transformMessage = options.transformMessage;
  }

  createEndpoint(peerId: string): InMemoryTransport {
    if (peerId.length === 0) throw new TransportError("peerId must not be empty.");
    if (this.#endpoints.has(peerId)) {
      throw new TransportError(`Peer already exists: ${peerId}.`);
    }
    const endpoint = new InMemoryTransport(this, peerId);
    this.#endpoints.set(peerId, endpoint);
    return endpoint;
  }

  endpoint(peerId: string): InMemoryTransport | undefined {
    return this.#endpoints.get(peerId);
  }

  disconnect(peerId: string): void {
    this.#endpoints.delete(peerId);
  }

  async routeMessage(
    senderPeerId: string,
    recipientPeerId: string,
    payload: unknown,
  ): Promise<void> {
    const recipient = this.endpoint(recipientPeerId);
    if (recipient === undefined) {
      throw new TransportError(`Peer is unavailable: ${recipientPeerId}.`);
    }
    const transformed =
      this.#transformMessage?.({ senderPeerId, recipientPeerId, payload }) ?? payload;
    await recipient.deliverMessage(senderPeerId, clonePayload(transformed));
  }
}

export class InMemoryTransport implements Transport {
  readonly peerId: string;
  readonly #network: InMemoryTransportNetwork;
  readonly #messageHandlers = new Set<MessageHandler>();
  #closed = false;

  constructor(network: InMemoryTransportNetwork, peerId: string) {
    this.#network = network;
    this.peerId = peerId;
  }

  async send(peerId: string, payload: unknown): Promise<void> {
    this.#assertOpen();
    await this.#network.routeMessage(this.peerId, peerId, payload);
  }

  onMessage(handler: MessageHandler): () => void {
    this.#assertOpen();
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#network.disconnect(this.peerId);
    this.#messageHandlers.clear();
  }

  async deliverMessage(peerId: string, payload: unknown): Promise<void> {
    this.#assertOpen();
    await Promise.all([...this.#messageHandlers].map(async (handler) => handler(peerId, payload)));
  }

  #assertOpen(): void {
    if (this.#closed) throw new TransportError(`Transport is closed: ${this.peerId}.`);
  }
}

function clonePayload(payload: unknown): unknown {
  try {
    return structuredClone(payload);
  } catch (error) {
    throw new TransportError(
      `Payload cannot cross the in-memory transport boundary: ${String(error)}.`,
    );
  }
}
