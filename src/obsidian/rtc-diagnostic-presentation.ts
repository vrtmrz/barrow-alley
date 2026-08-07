import type { RtcDiagnosticEvent } from "../transport/rtc-diagnostics.js";

/** Sanitised, non-identifying RTC information suitable for the sender UI. */
export interface RtcDiagnosticPresentation {
  readonly message: string;
  readonly totals?: string;
  readonly isFailure: boolean;
}

/**
 * Converts transport diagnostics into plain user-facing progress.
 *
 * The presentation deliberately omits peer-connection instance IDs, state
 * histories, and candidate-pair metrics. Those details help classification,
 * but do not help a sender decide whether to keep the pitch open.
 */
export function presentRtcDiagnostic(
  event: RtcDiagnosticEvent,
): RtcDiagnosticPresentation {
  if (event.type === "failure") {
    return {
      message: event.diagnosis.message,
      isFailure: true,
    };
  }

  return {
    message: statusMessage(event),
    totals: [
      `Attempts ${String(event.totals.attempted)}`,
      `Connected ${String(event.totals.connected)}`,
      `Failed ${String(event.totals.failed)}`,
      `Closed ${String(event.totals.closed)}`,
    ].join(" · "),
    isFailure:
      event.connectionState === "failed" || event.iceConnectionState === "failed",
  };
}

function statusMessage(event: Extract<RtcDiagnosticEvent, { readonly type: "status" }>): string {
  if (
    event.connectionState === "failed" ||
    event.iceConnectionState === "failed"
  ) {
    return "The direct connection attempt failed.";
  }
  if (event.connectionState === "connected") {
    return "Direct connection established.";
  }
  if (
    event.connectionState === "disconnected" ||
    event.iceConnectionState === "disconnected"
  ) {
    return "The direct connection was interrupted.";
  }
  if (event.connectionState === "closed") {
    return "The direct connection was closed.";
  }
  if (event.iceConnectionState === "checking") {
    return "A visitor was found. Checking a direct connection…";
  }
  const gathering = event.history.iceGathering.at(-1);
  if (gathering === "gathering") {
    return "A visitor was found. Gathering network routes…";
  }
  return "A visitor was found. Starting a direct connection…";
}
