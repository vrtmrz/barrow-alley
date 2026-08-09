import {
  getRelaySockets,
  joinRoom,
  selfId,
} from "@trystero-p2p/nostr";

import { compatGlobal } from "../compat-global.js";
import type { MessageHandler, Transport } from "./transport.js";
import { parseRelayUrls, RelaySettingsError } from "./relay-settings.js";
import {
  createDiagnosticRTCPeerConnectionConstructor,
  type RtcDiagnosticObserver,
} from "./rtc-diagnostics.js";

const ACTION_NAME = "barrow";
const FILE_CHUNK_ENVELOPE_VERSION = 1;
const DEFAULT_APP_ID = "barrow-alley";
const DEFAULT_RELAY_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_PEER_CONNECTION_TIMEOUT_MS = 30_000;
const RELAY_POLL_INTERVAL_MS = 25;

/** Local connection outcomes which never cross the Barrow Alley wire protocol. */
export type ConnectionErrorCode =
  | "NO_VALID_RELAYS"
  | "RELAY_UNAVAILABLE"
  | "ROOM_NOT_FOUND"
  | "WEBRTC_CONNECTION_FAILED"
  | "PEER_DISCONNECTED"
  | "TRANSPORT_CLOSED"
  | "TRANSPORT_FAILED";

/**
 * Reports a useful transport-layer failure without treating relay diagnostics
 * as peer-safe protocol errors.
 *
 * - `NO_VALID_RELAYS`: the effective setting is empty or contains a URL which
 *   production policy rejects.
 * - `RELAY_UNAVAILABLE`: no configured relay WebSocket opened before timeout.
 * - `ROOM_NOT_FOUND`: relay discovery worked, but no peer appeared in time.
 * - `WEBRTC_CONNECTION_FAILED`: Trystero discovered a peer but rejected its
 *   password/handshake or could not establish the direct WebRTC connection.
 * - `PEER_DISCONNECTED`: a targeted action could not reach its former peer.
 * - `TRANSPORT_CLOSED`: the owning pitch has already released the room.
 * - `TRANSPORT_FAILED`: another action or Trystero adapter operation failed.
 */
export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConnectionError";
    this.code = code;
  }
}

export interface TrysteroTransportOptions {
  /** Opaque Trystero room input derived from the user-entered Pitch number. */
  readonly roomId: string;
  /** Opaque SDP-encryption input derived from the same Pitch number. */
  readonly password: string;
  /** Complete effective relay snapshot for this new session. */
  readonly relays: readonly string[];
  /** Stable Trystero application namespace; normally the Barrow Alley default. */
  readonly appId?: string;
  /** Maximum wait for at least one configured relay WebSocket to open. */
  readonly relayConnectionTimeoutMs?: number;
  /** Default discovery wait and Trystero handshake timeout for this room. */
  readonly peerConnectionTimeoutMs?: number;
  /** Browser hosts omit this; server-side interoperability tests inject WebRTC. */
  readonly rtcPolyfill?: typeof RTCPeerConnection;
  /** Enables the sanitised LiveSync-derived diagnostic wrapper for this room. */
  readonly rtcDiagnostics?: RtcDiagnosticObserver;
  /** Test-only permission for a local, non-TLS strfry Compose fixture. */
  readonly allowInsecureLoopbackForTests?: boolean;
}

export interface WaitForPeerOptions {
  /** Overrides this transport's peer-discovery timeout for one wait. */
  readonly timeoutMs?: number;
  /** Cancels only this caller's wait; it does not close the room. */
  readonly signal?: AbortSignal;
}

/** Observes the opaque Trystero identity of a remote room member. */
export type PeerEventHandler = (peerId: string) => void;

/** Transport capabilities used by a host while discovering and tracking a peer. */
export interface PeerAwareTransport extends Transport {
  /** Returns the currently active Trystero peers without exposing WebRTC objects. */
  getPeerIds(): readonly string[];
  /** Registers for peers which complete Trystero's connection admission. */
  onPeerJoin(handler: PeerEventHandler): () => void;
  /** Registers for active peers whose Trystero connection closes. */
  onPeerLeave(handler: PeerEventHandler): () => void;
  /** Resolves with the first active peer or rejects with a classified timeout/failure. */
  waitForPeer(options?: WaitForPeerOptions): Promise<string>;
}

/** Untrusted context attached by Trystero to an incoming action. */
export interface TrysteroActionContext {
  /** Transport identity of the immediate action sender. */
  readonly peerId: string;
  /** Untrusted Trystero metadata, used only for the binary frame envelope. */
  readonly metadata?: unknown;
}

/** Injectable subset of a Trystero message action used by adapter tests. */
export interface TrysteroActionFacade {
  /** Sends one action to exactly one active peer and resolves after local backpressure. */
  send(
    data: unknown,
    options: { readonly target: string; readonly metadata?: unknown },
  ): Promise<void>;
  /** Single Trystero receive callback owned by this adapter instance. */
  onMessage:
    | ((data: unknown, context: TrysteroActionContext) => void | Promise<void>)
    | null;
}

/** Injectable subset of a Trystero room used by Barrow Alley. */
export interface TrysteroRoomFacade {
  /** Creates or retrieves the named one-way action. */
  makeAction(name: string): TrysteroActionFacade;
  /** Returns active peers; connection objects remain opaque to Barrow Alley. */
  getPeers(): Record<string, unknown>;
  /** Removes room subscriptions and closes its peer connections. */
  leave(): Promise<void>;
  /** Single room callback invoked after a peer becomes active. */
  onPeerJoin: PeerEventHandler | null;
  /** Single room callback invoked after an active peer leaves. */
  onPeerLeave: PeerEventHandler | null;
}

/** Failure detail supplied by Trystero's room-join callback. */
export interface TrysteroJoinError {
  /** Application namespace involved in the failed join. */
  readonly appId: string;
  /** Opaque room input involved in the failed join. */
  readonly roomId: string;
  /** Remote peer whose handshake or direct connection failed. */
  readonly peerId: string;
  /** Local diagnostic from Trystero; never forwarded to the other peer. */
  readonly error: string;
}

/** Join callbacks used to classify asynchronous WebRTC failures. */
export interface TrysteroJoinCallbacks {
  /** Upper bound for Trystero's pending peer handshake. */
  readonly handshakeTimeoutMs: number;
  /** Receives password, handshake, ICE, and direct-connection failures. */
  readonly onJoinError?: (details: TrysteroJoinError) => void;
}

/** Narrow configuration passed from the adapter to the Trystero runtime. */
export interface TrysteroJoinConfig {
  /** Stable Trystero application namespace. */
  readonly appId: string;
  /** Opaque key input used by Trystero to encrypt signalling descriptions. */
  readonly password: string;
  /** Complete relay snapshot and reconnection policy for this room. */
  readonly relayConfig: {
    /** Nostr relay URLs already validated by the shared parser. */
    readonly urls: readonly string[];
    /** `false` keeps Trystero's browser online/offline management enabled. */
    readonly manualReconnection: boolean;
  };
  /** Optional server-side WebRTC constructor used only by interoperability tests. */
  readonly rtcPolyfill?: typeof RTCPeerConnection;
}

export interface RelaySocketFacade {
  /** Uses the WebSocket ready-state values: 0 connecting, 1 open, and 3 closed. */
  readonly readyState: number;
}

/** Injectable Trystero module boundary; production uses `@trystero-p2p/nostr`. */
export interface TrysteroRuntime {
  /** Module-level local identity announced to remote peers. */
  readonly selfId: string;
  /** Creates one room through the Nostr strategy. */
  joinRoom(
    config: TrysteroJoinConfig,
    roomId: string,
    callbacks: TrysteroJoinCallbacks,
  ): TrysteroRoomFacade;
  /** Observes relay socket state without claiming publish/subscribe health. */
  getRelaySockets(): Readonly<Record<string, RelaySocketFacade>>;
}

interface PeerWaiter {
  readonly resolve: (peerId: string) => void;
  readonly reject: (error: ConnectionError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

/**
 * Adapts one owned Trystero room to the host-neutral Barrow Alley transport.
 *
 * Each instance installs the room's single peer/action callbacks and therefore
 * must exclusively own that room. `createTrysteroTransport` guarantees this by
 * using a distinct room input per pitch and leaving it on creation failure.
 */
export class TrysteroTransport implements PeerAwareTransport {
  readonly peerId: string;
  readonly #room: TrysteroRoomFacade;
  readonly #action: TrysteroActionFacade;
  readonly #peerConnectionTimeoutMs: number;
  readonly #messageHandlers = new Set<MessageHandler>();
  readonly #peerJoinHandlers = new Set<PeerEventHandler>();
  readonly #peerLeaveHandlers = new Set<PeerEventHandler>();
  readonly #peerWaiters = new Set<PeerWaiter>();
  #joinFailure: ConnectionError | undefined;
  #closed = false;

  constructor(
    peerId: string,
    room: TrysteroRoomFacade,
    peerConnectionTimeoutMs: number,
  ) {
    this.peerId = peerId;
    this.#room = room;
    this.#peerConnectionTimeoutMs = peerConnectionTimeoutMs;
    this.#action = room.makeAction(ACTION_NAME);
    this.#action.onMessage = async (data, context) => {
      const payload = decodeActionPayload(data, context.metadata);
      await Promise.all(
        [...this.#messageHandlers].map(async (handler) => handler(context.peerId, payload)),
      );
    };
    room.onPeerJoin = (remotePeerId) => this.#handlePeerJoin(remotePeerId);
    room.onPeerLeave = (remotePeerId) => {
      for (const handler of this.#peerLeaveHandlers) handler(remotePeerId);
    };
  }

  async send(remotePeerId: string, payload: unknown): Promise<void> {
    this.#assertOpen();
    const encoded = encodeActionPayload(payload);
    try {
      await this.#action.send(encoded.data, {
        target: remotePeerId,
        ...(encoded.metadata === undefined ? {} : { metadata: encoded.metadata }),
      });
    } catch (error) {
      if (isDisconnectedError(error)) {
        throw new ConnectionError(
          "PEER_DISCONNECTED",
          "The peer disconnected before the message could be sent.",
          error,
        );
      }
      throw new ConnectionError(
        "TRANSPORT_FAILED",
        "Barrow Alley could not send a message through the direct connection.",
        error,
      );
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.#assertOpen();
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  getPeerIds(): readonly string[] {
    if (this.#closed) return [];
    return Object.keys(this.#room.getPeers());
  }

  onPeerJoin(handler: PeerEventHandler): () => void {
    this.#assertOpen();
    this.#peerJoinHandlers.add(handler);
    return () => this.#peerJoinHandlers.delete(handler);
  }

  onPeerLeave(handler: PeerEventHandler): () => void {
    this.#assertOpen();
    this.#peerLeaveHandlers.add(handler);
    return () => this.#peerLeaveHandlers.delete(handler);
  }

  waitForPeer(options: WaitForPeerOptions = {}): Promise<string> {
    this.#assertOpen();
    const existingPeer = this.getPeerIds()[0];
    if (existingPeer !== undefined) return Promise.resolve(existingPeer);
    if (this.#joinFailure !== undefined) return Promise.reject(this.#joinFailure);

    const timeoutMs = options.timeoutMs ?? this.#peerConnectionTimeoutMs;
    assertPositiveTimeout(timeoutMs, "peer connection");

    return new Promise<string>((resolve, reject) => {
      let waiter: PeerWaiter;
      const abort = options.signal === undefined
        ? undefined
        : () => {
            this.#removePeerWaiter(waiter);
            reject(
              new ConnectionError(
                "TRANSPORT_FAILED",
                "Waiting for the peer was cancelled.",
                options.signal?.reason,
              ),
            );
          };
      const timer = compatGlobal.setTimeout(() => {
        this.#removePeerWaiter(waiter);
        reject(
          new ConnectionError(
            "ROOM_NOT_FOUND",
            "No active pitch was found before the connection timed out.",
          ),
        );
      }, timeoutMs);
      waiter = { resolve, reject, timer, signal: options.signal, abort };
      this.#peerWaiters.add(waiter);
      if (options.signal?.aborted === true) abort?.();
      else if (abort !== undefined) options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Records an asynchronous Trystero handshake or direct-connection failure. */
  reportJoinError(details: TrysteroJoinError): void {
    const failure = new ConnectionError(
      "WEBRTC_CONNECTION_FAILED",
      "The peer was discovered, but Barrow Alley could not establish a direct connection.",
      new Error(details.error),
    );
    this.#joinFailure = failure;
    for (const waiter of [...this.#peerWaiters]) {
      this.#removePeerWaiter(waiter);
      waiter.reject(failure);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new ConnectionError(
      "TRANSPORT_CLOSED",
      "This Barrow Alley transport is closed.",
    );
    for (const waiter of [...this.#peerWaiters]) {
      this.#removePeerWaiter(waiter);
      waiter.reject(closed);
    }
    this.#messageHandlers.clear();
    this.#peerJoinHandlers.clear();
    this.#peerLeaveHandlers.clear();
    this.#action.onMessage = null;
    this.#room.onPeerJoin = null;
    this.#room.onPeerLeave = null;
    await this.#room.leave();
  }

  #handlePeerJoin(remotePeerId: string): void {
    this.#joinFailure = undefined;
    for (const handler of this.#peerJoinHandlers) handler(remotePeerId);
    for (const waiter of [...this.#peerWaiters]) {
      this.#removePeerWaiter(waiter);
      waiter.resolve(remotePeerId);
    }
  }

  #removePeerWaiter(waiter: PeerWaiter): void {
    if (!this.#peerWaiters.delete(waiter)) return;
    compatGlobal.clearTimeout(waiter.timer);
    if (waiter.abort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ConnectionError("TRANSPORT_CLOSED", "This Barrow Alley transport is closed.");
    }
  }
}

/** Joins a Trystero room only after validating and snapshotting its relay set. */
export async function createTrysteroTransport(
  options: TrysteroTransportOptions,
  runtime: TrysteroRuntime = defaultTrysteroRuntime,
): Promise<TrysteroTransport> {
  let relays: string[];
  try {
    relays = parseRelayUrls(options.relays.join("\n"), {
      ...(options.allowInsecureLoopbackForTests === undefined
        ? {}
        : { allowInsecureLoopbackForTests: options.allowInsecureLoopbackForTests }),
    });
  } catch (error) {
    if (!(error instanceof RelaySettingsError)) throw error;
    throw new ConnectionError(
      "NO_VALID_RELAYS",
      "Configure at least one valid Nostr relay before setting up a pitch.",
      error,
    );
  }

  const relayTimeoutMs =
    options.relayConnectionTimeoutMs ?? DEFAULT_RELAY_CONNECTION_TIMEOUT_MS;
  const peerTimeoutMs =
    options.peerConnectionTimeoutMs ?? DEFAULT_PEER_CONNECTION_TIMEOUT_MS;
  assertPositiveTimeout(relayTimeoutMs, "relay connection");
  assertPositiveTimeout(peerTimeoutMs, "peer connection");

  let transport: TrysteroTransport | undefined;
  let earlyJoinFailure: TrysteroJoinError | undefined;
  let room: TrysteroRoomFacade;
  const rtcPolyfill = resolveRtcConstructor(options);
  try {
    room = runtime.joinRoom(
      {
        appId: options.appId ?? DEFAULT_APP_ID,
        password: options.password,
        relayConfig: {
          urls: [...relays],
          manualReconnection: false,
        },
        ...(rtcPolyfill === undefined ? {} : { rtcPolyfill }),
      },
      options.roomId,
      {
        handshakeTimeoutMs: peerTimeoutMs,
        onJoinError(details) {
          if (transport === undefined) earlyJoinFailure = details;
          else transport.reportJoinError(details);
        },
      },
    );
  } catch (error) {
    throw new ConnectionError(
      "TRANSPORT_FAILED",
      "Barrow Alley could not create the Trystero room.",
      error,
    );
  }
  transport = new TrysteroTransport(runtime.selfId, room, peerTimeoutMs);
  if (earlyJoinFailure !== undefined) transport.reportJoinError(earlyJoinFailure);

  try {
    await waitForRelayConnection(relays, relayTimeoutMs, runtime);
    return transport;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

function resolveRtcConstructor(
  options: TrysteroTransportOptions,
): typeof RTCPeerConnection | undefined {
  if (options.rtcDiagnostics === undefined) return options.rtcPolyfill;
  const BasePeerConnection = options.rtcPolyfill ?? compatGlobal.RTCPeerConnection;
  if (typeof BasePeerConnection !== "function") {
    throw new ConnectionError(
      "TRANSPORT_FAILED",
      "RTCPeerConnection is unavailable for direct-connection diagnostics.",
    );
  }
  return createDiagnosticRTCPeerConnectionConstructor(
    BasePeerConnection,
    options.rtcDiagnostics,
  );
}

const defaultTrysteroRuntime: TrysteroRuntime = {
  selfId,
  joinRoom(config, roomId, callbacks) {
    const room = joinRoom(
      {
        appId: config.appId,
        password: config.password,
        relayConfig: {
          urls: [...config.relayConfig.urls],
          manualReconnection: config.relayConfig.manualReconnection,
        },
        ...(config.rtcPolyfill === undefined ? {} : { rtcPolyfill: config.rtcPolyfill }),
      },
      roomId,
      callbacks,
    );
    return {
      makeAction(name) {
        const action = room.makeAction(name);
        return {
          send(data, options) {
            return action.send(data as never, {
              target: options.target,
              ...(options.metadata === undefined
                ? {}
                : { metadata: options.metadata as never }),
            });
          },
          get onMessage() {
            return action.onMessage as TrysteroActionFacade["onMessage"];
          },
          set onMessage(handler) {
            action.onMessage = handler;
          },
        };
      },
      getPeers: () => room.getPeers(),
      leave: () => room.leave(),
      get onPeerJoin() {
        return room.onPeerJoin;
      },
      set onPeerJoin(handler) {
        room.onPeerJoin = handler;
      },
      get onPeerLeave() {
        return room.onPeerLeave;
      },
      set onPeerLeave(handler) {
        room.onPeerLeave = handler;
      },
    };
  },
  getRelaySockets: readRelaySockets,
};

interface EncodedActionPayload {
  readonly data: unknown;
  readonly metadata?: unknown;
}

function encodeActionPayload(payload: unknown): EncodedActionPayload {
  if (!isRecord(payload) || payload.type !== "file-chunk" || !(payload.data instanceof Uint8Array)) {
    return { data: payload };
  }
  const { data, ...message } = payload;
  return {
    data,
    metadata: {
      barrowAlleyEnvelope: FILE_CHUNK_ENVELOPE_VERSION,
      message,
    },
  };
}

function decodeActionPayload(data: unknown, metadata: unknown): unknown {
  if (
    !isRecord(metadata) ||
    metadata.barrowAlleyEnvelope !== FILE_CHUNK_ENVELOPE_VERSION ||
    !isRecord(metadata.message) ||
    metadata.message.type !== "file-chunk" ||
    !(data instanceof Uint8Array)
  ) {
    return data;
  }
  return { ...metadata.message, data };
}

async function waitForRelayConnection(
  relays: readonly string[],
  timeoutMs: number,
  runtime: TrysteroRuntime,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const allSockets = runtime.getRelaySockets();
    const sockets = relays
      .map((relay) => allSockets[relay])
      .filter((socket): socket is RelaySocketFacade => socket !== undefined);
    if (sockets.some((socket) => socket.readyState === 1)) return;
    if (sockets.length > 0 && sockets.every((socket) => socket.readyState === 3)) {
      throw relayUnavailable();
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw relayUnavailable();
    await delay(Math.min(RELAY_POLL_INTERVAL_MS, remainingMs));
  }
}

function relayUnavailable(): ConnectionError {
  return new ConnectionError(
    "RELAY_UNAVAILABLE",
    "Barrow Alley could not connect to any configured Nostr relay.",
  );
}

function assertPositiveTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} timeout must be a positive integer.`);
  }
}

function isDisconnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|no active peer/iu.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRelaySockets(): Readonly<Record<string, RelaySocketFacade>> {
  // Trystero 0.25.3 publishes this function as `any`; narrow the untyped
  // upstream value immediately, then validate it before exposing our facade.
  const readUntypedRelaySockets = getRelaySockets as unknown as () => unknown;
  const relaySockets = readUntypedRelaySockets();
  if (!isRecord(relaySockets)) return {};
  return Object.fromEntries(
    Object.entries(relaySockets).flatMap(([url, socket]) =>
      isRecord(socket) && typeof socket.readyState === "number"
        ? [[url, { readyState: socket.readyState }]]
        : [],
    ),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => compatGlobal.setTimeout(resolve, milliseconds));
}
