import type { RtcDiagnosticEvent } from "./rtc-diagnostics.js";

/** Sanitised, non-identifying RTC information suitable for persistent host UI. */
export interface RtcDiagnosticPresentation {
    readonly message: string;
    readonly totals?: string;
    readonly isFailure: boolean;
}

/** Role label used only in sanitised user-facing connection progress. */
export type RtcDiagnosticPeerLabel = "visitor" | "sender";

/**
 * Converts transport diagnostics into plain user-facing progress.
 *
 * The presentation deliberately omits peer-connection instance IDs, state
 * histories, and candidate-pair metrics. Those details help classification,
 * but do not help a user decide whether to keep the pitch open.
 */
export function presentRtcDiagnostic(
    event: RtcDiagnosticEvent,
    peerLabel: RtcDiagnosticPeerLabel = "visitor",
): RtcDiagnosticPresentation {
    if (event.type === "failure") {
        return {
            message: event.diagnosis.message,
            isFailure: true,
        };
    }

    return {
        message: statusMessage(event, peerLabel),
        totals: [
            `Attempts ${String(event.totals.attempted)}`,
            `Connected ${String(event.totals.connected)}`,
            `Failed ${String(event.totals.failed)}`,
            `Closed ${String(event.totals.closed)}`,
        ].join(" · "),
        isFailure: event.connectionState === "failed" || event.iceConnectionState === "failed",
    };
}

function statusMessage(
    event: Extract<RtcDiagnosticEvent, { readonly type: "status" }>,
    peerLabel: RtcDiagnosticPeerLabel,
): string {
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
        return `A ${peerLabel} was found. Checking a direct connection…`;
    }
    const gathering = event.history.iceGathering.at(-1);
    if (gathering === "gathering") {
        return `A ${peerLabel} was found. Gathering network routes…`;
    }
    return `A ${peerLabel} was found. Starting a direct connection…`;
}
