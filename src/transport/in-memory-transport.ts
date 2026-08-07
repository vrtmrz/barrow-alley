import type {
  IncomingTransfer,
  MessageHandler,
  TransferHandler,
  Transport,
} from "./transport.js";

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Owns isolated endpoints for deterministic session integration tests.
 *
 * It models peer identity, routing, and closure only. It intentionally does not
 * simulate Trystero, network timing, wire framing, or DataChannel buffering.
 */
export class InMemoryTransportNetwork {
  readonly #endpoints = new Map<string, InMemoryTransport>();

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
}

export class InMemoryTransport implements Transport {
  readonly peerId: string;
  readonly #network: InMemoryTransportNetwork;
  readonly #messageHandlers = new Set<MessageHandler>();
  #transferHandler: TransferHandler | undefined;
  #closed = false;

  constructor(network: InMemoryTransportNetwork, peerId: string) {
    this.#network = network;
    this.peerId = peerId;
  }

  async send(peerId: string, payload: unknown): Promise<void> {
    this.#assertOpen();
    const recipient = this.#network.endpoint(peerId);
    if (recipient === undefined) throw new TransportError(`Peer is unavailable: ${peerId}.`);
    await recipient.deliverMessage(this.peerId, payload);
  }

  async sendTransfer(peerId: string, transfer: IncomingTransfer): Promise<void> {
    this.#assertOpen();
    const recipient = this.#network.endpoint(peerId);
    if (recipient === undefined) throw new TransportError(`Peer is unavailable: ${peerId}.`);
    await recipient.deliverTransfer(this.peerId, {
      sessionId: transfer.sessionId,
      fileId: transfer.fileId,
      chunks: cloneChunks(transfer.chunks),
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.#assertOpen();
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onTransfer(handler: TransferHandler): () => void {
    this.#assertOpen();
    // One consumer mirrors the session invariant of one active destination writer
    // and avoids sharing a single asynchronous iterator between observers.
    if (this.#transferHandler !== undefined) {
      throw new TransportError(`Peer already has a transfer handler: ${this.peerId}.`);
    }
    this.#transferHandler = handler;
    return () => {
      if (this.#transferHandler === handler) this.#transferHandler = undefined;
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#network.disconnect(this.peerId);
    this.#messageHandlers.clear();
    this.#transferHandler = undefined;
  }

  async deliverMessage(peerId: string, payload: unknown): Promise<void> {
    this.#assertOpen();
    await Promise.all([...this.#messageHandlers].map(async (handler) => handler(peerId, payload)));
  }

  async deliverTransfer(peerId: string, transfer: IncomingTransfer): Promise<void> {
    this.#assertOpen();
    if (this.#transferHandler === undefined) {
      throw new TransportError(`Peer has no transfer handler: ${this.peerId}.`);
    }
    await this.#transferHandler(peerId, transfer);
  }

  #assertOpen(): void {
    if (this.#closed) throw new TransportError(`Transport is closed: ${this.peerId}.`);
  }
}

async function* cloneChunks(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  // Copying prevents sender and receiver tests from accidentally sharing mutable
  // Uint8Array storage, while preserving streaming rather than buffering the file.
  for await (const chunk of chunks) yield chunk.slice();
}
