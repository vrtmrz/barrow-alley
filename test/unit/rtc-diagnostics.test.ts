import { describe, expect, it } from "vitest";

import {
    createDiagnosticRTCPeerConnectionConstructor,
    diagnoseRtcFailure,
    type RtcDiagnosticEvent,
    type RtcStateHistory,
} from "../../src/transport/rtc-diagnostics.js";

class FakePeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = "new";
    iceConnectionState: RTCIceConnectionState = "new";
    iceGatheringState: RTCIceGatheringState = "new";
    signalingState: RTCSignalingState = "stable";

    constructor(_configuration?: RTCConfiguration) {
        super();
    }

    async getStats(): Promise<RTCStatsReport> {
        const reports = new Map<string, Record<string, unknown>>([
            [
                "pair-secret-identifier",
                {
                    id: "pair-secret-identifier",
                    type: "candidate-pair",
                    nominated: true,
                    state: "in-progress",
                    localCandidateId: "local-secret-identifier",
                    remoteCandidateId: "remote-secret-identifier",
                    requestsSent: 3,
                    responsesReceived: 0,
                    bytesSent: 12,
                    bytesReceived: 0,
                    address: "192.0.2.10",
                },
            ],
        ]);
        return reports as unknown as RTCStatsReport;
    }

    move(states: {
        readonly connection?: RTCPeerConnectionState;
        readonly iceConnection?: RTCIceConnectionState;
        readonly iceGathering?: RTCIceGatheringState;
        readonly signaling?: RTCSignalingState;
    }): void {
        if (states.connection !== undefined) {
            this.connectionState = states.connection;
            this.dispatchEvent(new Event("connectionstatechange"));
        }
        if (states.iceConnection !== undefined) {
            this.iceConnectionState = states.iceConnection;
            this.dispatchEvent(new Event("iceconnectionstatechange"));
        }
        if (states.iceGathering !== undefined) {
            this.iceGatheringState = states.iceGathering;
            this.dispatchEvent(new Event("icegatheringstatechange"));
        }
        if (states.signaling !== undefined) {
            this.signalingState = states.signaling;
            this.dispatchEvent(new Event("signalingstatechange"));
        }
    }
}

const EMPTY_HISTORY: RtcStateHistory = {
    connection: [],
    iceConnection: [],
    iceGathering: [],
    signaling: ["stable"],
};

describe("RTC diagnostics", () => {
    it("classifies common state-history failures without candidate details", () => {
        expect(
            diagnoseRtcFailure(
                {
                    ...EMPTY_HISTORY,
                    iceGathering: ["gathering"],
                },
                undefined,
            ),
        ).toEqual({
            reason: "ICE_GATHERING_NOT_COMPLETED",
            message:
                "Connection could not collect enough network candidates. Check VPN, proxy, or firewall settings.",
        });

        expect(
            diagnoseRtcFailure(
                {
                    ...EMPTY_HISTORY,
                    iceConnection: ["checking", "failed"],
                },
                undefined,
            ).reason,
        ).toBe("ICE_CONNECTIVITY_FAILED");
    });

    it("wraps the supplied constructor and emits one sanitised failure diagnosis", async () => {
        const events: RtcDiagnosticEvent[] = [];
        const DiagnosticPeerConnection = createDiagnosticRTCPeerConnectionConstructor(
            FakePeerConnection as unknown as typeof RTCPeerConnection,
            (event) => events.push(event),
        );
        const peer = new DiagnosticPeerConnection() as unknown as FakePeerConnection;

        peer.move({ iceGathering: "gathering" });
        peer.move({ iceGathering: "complete" });
        peer.move({ iceConnection: "checking" });
        peer.move({ iceConnection: "failed" });
        peer.move({ connection: "failed" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const failures = events.filter((event) => event.type === "failure");
        expect(failures).toHaveLength(1);
        expect(failures[0]).toEqual(
            expect.objectContaining({
                type: "failure",
                diagnosis: expect.objectContaining({ reason: "ICE_CONNECTIVITY_FAILED" }),
                metrics: {
                    pairState: "in-progress",
                    requestsSent: 3,
                    responsesReceived: 0,
                    bytesSent: 12,
                    bytesReceived: 0,
                },
            }),
        );
        expect(JSON.stringify(events)).not.toMatch(
            /192\.0\.2\.10|pair-secret|local-secret|remote-secret/iu,
        );
        expect(events.find((event) => event.type === "status")).toEqual(
            expect.objectContaining({
                totals: { attempted: 1, connected: 0, failed: 0, closed: 0 },
            }),
        );
    });

    it("isolates observer failures from RTCPeerConnection events", () => {
        const DiagnosticPeerConnection = createDiagnosticRTCPeerConnectionConstructor(
            FakePeerConnection as unknown as typeof RTCPeerConnection,
            () => {
                throw new Error("observer failed");
            },
        );
        const peer = new DiagnosticPeerConnection() as unknown as FakePeerConnection;

        expect(() => peer.move({ connection: "connecting" })).not.toThrow();
    });
});
