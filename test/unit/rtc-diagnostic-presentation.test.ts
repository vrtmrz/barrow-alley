import { describe, expect, it } from "vitest";

import { presentRtcDiagnostic } from "../../src/obsidian/rtc-diagnostic-presentation.js";
import type { RtcDiagnosticEvent, RtcStateHistory } from "../../src/transport/rtc-diagnostics.js";

const EMPTY_HISTORY: RtcStateHistory = {
    connection: [],
    iceConnection: [],
    iceGathering: [],
    signaling: [],
};

function status(
    connectionState: RTCPeerConnectionState,
    iceConnectionState: RTCIceConnectionState,
    history: RtcStateHistory = EMPTY_HISTORY,
): RtcDiagnosticEvent {
    return {
        type: "status",
        instanceId: "rtc-1",
        connectionState,
        iceConnectionState,
        history,
        totals: { attempted: 2, connected: 1, failed: 0, closed: 0 },
    };
}

describe("RTC diagnostic presentation", () => {
    it("describes a detected visitor connection attempt and its safe totals", () => {
        expect(presentRtcDiagnostic(status("connecting", "checking"))).toEqual({
            message: "A visitor was found. Checking a direct connection…",
            totals: "Attempts 2 · Connected 1 · Failed 0 · Closed 0",
            isFailure: false,
        });
    });

    it("distinguishes route gathering and an established direct connection", () => {
        expect(
            presentRtcDiagnostic(
                status("new", "new", {
                    ...EMPTY_HISTORY,
                    iceGathering: ["gathering"],
                }),
            ).message,
        ).toBe("A visitor was found. Gathering network routes…");
        expect(presentRtcDiagnostic(status("connected", "connected")).message).toBe(
            "Direct connection established.",
        );
        expect(presentRtcDiagnostic(status("closed", "closed")).message).toBe(
            "The direct connection was closed.",
        );
    });

    it("uses the sanitised diagnosis for a failed connection", () => {
        const event: RtcDiagnosticEvent = {
            type: "failure",
            instanceId: "rtc-1",
            diagnosis: {
                reason: "ICE_CONNECTIVITY_FAILED",
                message:
                    "Connection attempt reached candidate checks but no route was established.",
            },
            history: EMPTY_HISTORY,
            metrics: {
                pairState: "unknown",
                requestsSent: "unknown",
                responsesReceived: "unknown",
                bytesSent: "unknown",
                bytesReceived: "unknown",
            },
        };

        expect(presentRtcDiagnostic(event)).toEqual({
            message: "Connection attempt reached candidate checks but no route was established.",
            isFailure: true,
        });
    });
});
