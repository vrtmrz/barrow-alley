/**
 * Sanitised RTCPeerConnection diagnostics adapted from Self-hosted LiveSync's
 * `DiagRTCPeerConnections` wrapper.
 *
 * The wrapper observes state transitions and selected-pair counters only. It
 * deliberately excludes SDP, candidate addresses, candidate IDs, and raw
 * `getStats()` reports from its public events.
 */

export type RtcFailureReason =
  | "ICE_GATHERING_NOT_COMPLETED"
  | "ICE_CONNECTIVITY_FAILED"
  | "STUN_REQUEST_TIMEOUT"
  | "SIGNALING_NOT_STABLE"
  | "CONNECTION_DROPPED_AFTER_ESTABLISHED"
  | "NETWORK_INTERRUPTED"
  | "UNKNOWN";

/** Stable failure classification and direct user-facing explanation. */
export interface RtcFailureDiagnosis {
  readonly reason: RtcFailureReason;
  readonly message: string;
}

/** State history retained only for the lifetime of one peer connection. */
export interface RtcStateHistory {
  readonly connection: readonly RTCPeerConnectionState[];
  readonly iceConnection: readonly RTCIceConnectionState[];
  readonly iceGathering: readonly RTCIceGatheringState[];
  readonly signaling: readonly RTCSignalingState[];
}

/** Aggregate selected-pair counters which do not identify network endpoints. */
export interface RtcDiagnosticMetrics {
  readonly pairState: string;
  readonly requestsSent: number | "unknown";
  readonly responsesReceived: number | "unknown";
  readonly bytesSent: number | "unknown";
  readonly bytesReceived: number | "unknown";
}

export type RtcDiagnosticEvent =
  | {
      readonly type: "status";
      readonly instanceId: string;
      readonly connectionState: RTCPeerConnectionState;
      readonly iceConnectionState: RTCIceConnectionState;
      readonly history: RtcStateHistory;
      readonly totals: {
        /** RTCPeerConnection instances created for this room. */
        readonly attempted: number;
        readonly connected: number;
        readonly failed: number;
        readonly closed: number;
      };
    }
  | {
      readonly type: "failure";
      readonly instanceId: string;
      readonly diagnosis: RtcFailureDiagnosis;
      readonly history: RtcStateHistory;
      readonly metrics: RtcDiagnosticMetrics;
    };

/** Presentation or logging observer; exceptions never affect WebRTC. */
export type RtcDiagnosticObserver = (event: RtcDiagnosticEvent) => void;

/**
 * Wraps an explicitly supplied native or polyfilled constructor.
 *
 * Supplying the constructor, rather than replacing `globalThis`, keeps the
 * diagnostic scope limited to the Trystero room which opts into it.
 */
export function createDiagnosticRTCPeerConnectionConstructor(
  BasePeerConnection: typeof RTCPeerConnection,
  observer: RtcDiagnosticObserver,
): typeof RTCPeerConnection {
  let instanceCounter = 0;
  let connected = 0;
  let failed = 0;
  let closed = 0;

  return class DiagnosticRTCPeerConnection extends BasePeerConnection {
    readonly #instanceId: string;
    readonly #connectionHistory: RTCPeerConnectionState[] = [];
    readonly #iceConnectionHistory: RTCIceConnectionState[] = [];
    readonly #iceGatheringHistory: RTCIceGatheringState[] = [];
    readonly #signalingHistory: RTCSignalingState[] = [];
    #previousConnectionState: RTCPeerConnectionState | undefined;
    #failureReported = false;

    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      instanceCounter += 1;
      this.#instanceId = `rtc-${String(instanceCounter)}`;
      this.addEventListener("connectionstatechange", () => {
        this.#connectionHistory.push(this.connectionState);
        this.#trackStatus();
        this.#inspectFailureState();
      });
      this.addEventListener("iceconnectionstatechange", () => {
        this.#iceConnectionHistory.push(this.iceConnectionState);
        this.#trackStatus();
        this.#inspectFailureState();
      });
      this.addEventListener("icegatheringstatechange", () => {
        this.#iceGatheringHistory.push(this.iceGatheringState);
        this.#emitStatus();
      });
      this.addEventListener("signalingstatechange", () => {
        this.#signalingHistory.push(this.signalingState);
        this.#emitStatus();
      });
    }

    #trackStatus(): void {
      if (this.#previousConnectionState !== this.connectionState) {
        if (this.connectionState === "connected") connected += 1;
        if (this.connectionState === "failed") failed += 1;
        if (this.connectionState === "closed") closed += 1;
        this.#previousConnectionState = this.connectionState;
      }
      this.#emitStatus();
    }

    #emitStatus(): void {
      emitRtcDiagnostic(observer, {
        type: "status",
        instanceId: this.#instanceId,
        connectionState: this.connectionState,
        iceConnectionState: this.iceConnectionState,
        history: this.#historySnapshot(),
        totals: { attempted: instanceCounter, connected, failed, closed },
      });
    }

    #inspectFailureState(): void {
      const hasFailed =
        this.connectionState === "failed" || this.iceConnectionState === "failed";
      if (!hasFailed) {
        this.#failureReported = false;
        return;
      }
      if (this.#failureReported) return;
      this.#failureReported = true;
      void this.#diagnoseFailure();
    }

    async #diagnoseFailure(): Promise<void> {
      const selectedPair = await readSelectedCandidatePair(this);
      emitRtcDiagnostic(observer, {
        type: "failure",
        instanceId: this.#instanceId,
        diagnosis: diagnoseRtcFailure(this.#historySnapshot(), selectedPair),
        history: this.#historySnapshot(),
        metrics: sanitisePairMetrics(selectedPair),
      });
    }

    #historySnapshot(): RtcStateHistory {
      return {
        connection: [...this.#connectionHistory],
        iceConnection: [...this.#iceConnectionHistory],
        iceGathering: [...this.#iceGatheringHistory],
        signaling: [...this.#signalingHistory],
      };
    }
  };
}

/** Applies LiveSync's ordered heuristics to state history and selected-pair counters. */
export function diagnoseRtcFailure(
  history: RtcStateHistory,
  selectedPair: Readonly<Record<string, unknown>> | undefined,
): RtcFailureDiagnosis {
  const hasSelectedPair = selectedPair !== undefined;
  const selectedPairState = readString(selectedPair, "state");
  const requestsSent = readFiniteNumber(selectedPair, "requestsSent");
  const responsesReceived = readFiniteNumber(selectedPair, "responsesReceived");
  const gatheringStarted = history.iceGathering.includes("gathering");
  const gatheringCompleted = history.iceGathering.includes("complete");
  const iceChecking = history.iceConnection.includes("checking");
  const iceConnected = history.iceConnection.includes("connected");
  const iceFailed = history.iceConnection.includes("failed");
  const iceDisconnected = history.iceConnection.includes("disconnected");
  const connectionConnected = history.connection.includes("connected");
  const connectionFailed = history.connection.includes("failed");
  const signalingStable = history.signaling.includes("stable");

  if (!hasSelectedPair && gatheringStarted && !gatheringCompleted) {
    return {
      reason: "ICE_GATHERING_NOT_COMPLETED",
      message:
        "Connection could not collect enough network candidates. Check VPN, proxy, or firewall settings.",
    };
  }
  if (iceChecking && iceFailed && !iceConnected) {
    return {
      reason: "ICE_CONNECTIVITY_FAILED",
      message: "Connection attempt reached candidate checks but no route was established.",
    };
  }
  if (
    hasSelectedPair &&
    selectedPairState !== "succeeded" &&
    (requestsSent ?? 0) > 0 &&
    (responsesReceived ?? 0) === 0
  ) {
    return {
      reason: "STUN_REQUEST_TIMEOUT",
      message:
        "Connection requests were sent but no response was returned. The network path may block UDP or STUN.",
    };
  }
  if (!signalingStable) {
    return {
      reason: "SIGNALING_NOT_STABLE",
      message: "Connection negotiation did not reach a stable signalling state.",
    };
  }
  if (connectionConnected && connectionFailed) {
    return {
      reason: "CONNECTION_DROPPED_AFTER_ESTABLISHED",
      message: "The connection was established, but dropped afterwards.",
    };
  }
  if (iceDisconnected && iceFailed) {
    return {
      reason: "NETWORK_INTERRUPTED",
      message: "The connection was interrupted while exchanging data.",
    };
  }
  return {
    reason: "UNKNOWN",
    message: "The direct connection failed for an unknown reason. Try setting up the pitch again.",
  };
}

async function readSelectedCandidatePair(
  peer: RTCPeerConnection,
): Promise<Record<string, unknown> | undefined> {
  try {
    const reports: Record<string, unknown>[] = [];
    const stats = await peer.getStats();
    stats.forEach((report) => reports.push(report as Record<string, unknown>));
    return reports.find(
      (report) =>
        report.type === "candidate-pair" &&
        (report.selected === true || report.nominated === true),
    );
  } catch {
    return undefined;
  }
}

function sanitisePairMetrics(
  selectedPair: Readonly<Record<string, unknown>> | undefined,
): RtcDiagnosticMetrics {
  return {
    pairState: readString(selectedPair, "state"),
    requestsSent: readFiniteNumber(selectedPair, "requestsSent") ?? "unknown",
    responsesReceived: readFiniteNumber(selectedPair, "responsesReceived") ?? "unknown",
    bytesSent: readFiniteNumber(selectedPair, "bytesSent") ?? "unknown",
    bytesReceived: readFiniteNumber(selectedPair, "bytesReceived") ?? "unknown",
  };
}

function readString(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "unknown";
}

function readFiniteNumber(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function emitRtcDiagnostic(observer: RtcDiagnosticObserver, event: RtcDiagnosticEvent): void {
  try {
    observer(event);
  } catch {
    // Diagnostics must never change the connection lifecycle they observe.
  }
}
