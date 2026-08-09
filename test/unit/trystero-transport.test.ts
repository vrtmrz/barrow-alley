import { describe, expect, it, vi } from "vitest";

import {
    ConnectionError,
    createTrysteroTransport,
    type TrysteroActionFacade,
    type TrysteroJoinCallbacks,
    type TrysteroJoinConfig,
    type TrysteroRoomFacade,
    type TrysteroRuntime,
} from "../../src/transport/trystero-transport.js";

class FakePeerConnection extends EventTarget {
    connectionState: RTCPeerConnectionState = "new";
    iceConnectionState: RTCIceConnectionState = "new";
    iceGatheringState: RTCIceGatheringState = "new";
    signalingState: RTCSignalingState = "stable";

    async getStats(): Promise<RTCStatsReport> {
        return new Map() as unknown as RTCStatsReport;
    }
}

class FakeAction implements TrysteroActionFacade {
    onMessage: TrysteroActionFacade["onMessage"] = null;
    readonly sent: Array<{
        readonly data: unknown;
        readonly target: string;
        readonly metadata: unknown;
    }> = [];
    sendError: Error | undefined;

    async send(
        data: unknown,
        options: { readonly target: string; readonly metadata?: unknown },
    ): Promise<void> {
        if (this.sendError !== undefined) throw this.sendError;
        this.sent.push({ data, target: options.target, metadata: options.metadata });
    }

    deliver(data: unknown, peerId: string, metadata?: unknown): void {
        void this.onMessage?.(data, { peerId, metadata });
    }
}

class FakeRoom implements TrysteroRoomFacade {
    readonly action = new FakeAction();
    readonly peers: Record<string, unknown> = {};
    onPeerJoin: ((peerId: string) => void) | null = null;
    onPeerLeave: ((peerId: string) => void) | null = null;
    leaveCalls = 0;

    makeAction(): TrysteroActionFacade {
        return this.action;
    }

    getPeers(): Record<string, unknown> {
        return this.peers;
    }

    async leave(): Promise<void> {
        this.leaveCalls += 1;
    }

    joinPeer(peerId: string): void {
        this.peers[peerId] = {};
        this.onPeerJoin?.(peerId);
    }

    leavePeer(peerId: string): void {
        delete this.peers[peerId];
        this.onPeerLeave?.(peerId);
    }
}

function createRuntime(socketState = 1): {
    readonly runtime: TrysteroRuntime;
    readonly room: FakeRoom;
    readonly joinCalls: Array<{
        readonly config: TrysteroJoinConfig;
        readonly roomId: string;
    }>;
    getCallbacks(): TrysteroJoinCallbacks;
} {
    const room = new FakeRoom();
    const joinCalls: Array<{ readonly config: TrysteroJoinConfig; readonly roomId: string }> = [];
    let callbacks: TrysteroJoinCallbacks | undefined;
    return {
        runtime: {
            selfId: "local-peer",
            joinRoom(config, roomId, nextCallbacks) {
                joinCalls.push({ config, roomId });
                callbacks = nextCallbacks;
                return room;
            },
            getRelaySockets: () => ({ "wss://relay.example": { readyState: socketState } }),
        },
        room,
        joinCalls,
        getCallbacks() {
            if (callbacks === undefined) throw new Error("Room has not been joined.");
            return callbacks;
        },
    };
}

const baseOptions = {
    roomId: "derived-room",
    password: "derived-password",
    relays: ["wss://relay.example"],
    relayConnectionTimeoutMs: 20,
} as const;

describe("Trystero transport", () => {
    it("wraps an explicit WebRTC constructor when diagnostics are requested", async () => {
        const { runtime, joinCalls } = createRuntime();
        const observer = vi.fn();

        await createTrysteroTransport(
            {
                ...baseOptions,
                rtcPolyfill: FakePeerConnection as unknown as typeof RTCPeerConnection,
                rtcDiagnostics: observer,
            },
            runtime,
        );

        const supplied = joinCalls[0]?.config.rtcPolyfill;
        expect(supplied).toBeTypeOf("function");
        expect(supplied).not.toBe(FakePeerConnection);
        expect(new (supplied ?? RTCPeerConnection)()).toBeInstanceOf(FakePeerConnection);
    });

    it("targets one peer and preserves binary file-frame data through metadata", async () => {
        const { runtime, room } = createRuntime();
        const transport = await createTrysteroTransport(baseOptions, runtime);
        const received: unknown[] = [];
        transport.onMessage((_peerId, payload) => {
            received.push(payload);
        });
        const payload = {
            type: "file-chunk",
            protocolVersion: 1,
            sessionId: "session",
            fileId: "file",
            index: 0,
            offset: 0,
            data: Uint8Array.of(1, 2, 3),
        };

        await transport.send("remote-peer", payload);

        expect(room.action.sent).toEqual([
            {
                data: Uint8Array.of(1, 2, 3),
                target: "remote-peer",
                metadata: {
                    barrowAlleyEnvelope: 1,
                    message: {
                        type: "file-chunk",
                        protocolVersion: 1,
                        sessionId: "session",
                        fileId: "file",
                        index: 0,
                        offset: 0,
                    },
                },
            },
        ]);

        const sent = room.action.sent[0];
        if (sent === undefined) throw new Error("Expected a sent action.");
        room.action.deliver(sent.data, "remote-peer", sent.metadata);
        expect(received).toEqual([payload]);
    });

    it("waits for an existing or newly connected peer", async () => {
        const { runtime, room } = createRuntime();
        const transport = await createTrysteroTransport(baseOptions, runtime);
        const pendingPeer = transport.waitForPeer({ timeoutMs: 100 });

        room.joinPeer("visitor-peer");

        await expect(pendingPeer).resolves.toBe("visitor-peer");
        await expect(transport.waitForPeer({ timeoutMs: 1 })).resolves.toBe("visitor-peer");
    });

    it("reports a room timeout when no peer is discovered", async () => {
        const { runtime } = createRuntime();
        const transport = await createTrysteroTransport(baseOptions, runtime);

        await expect(transport.waitForPeer({ timeoutMs: 1 })).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({ code: "ROOM_NOT_FOUND" }),
        );
    });

    it("reports Trystero join failures as direct connection failures", async () => {
        const { runtime, getCallbacks } = createRuntime();
        const transport = await createTrysteroTransport(baseOptions, runtime);
        getCallbacks().onJoinError?.({
            appId: "barrow-alley",
            roomId: "derived-room",
            peerId: "visitor-peer",
            error: "ICE negotiation failed",
        });

        await expect(transport.waitForPeer({ timeoutMs: 20 })).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({
                code: "WEBRTC_CONNECTION_FAILED",
            }),
        );
    });

    it("fails clearly when no configured relay opens", async () => {
        const { runtime } = createRuntime(3);

        await expect(createTrysteroTransport(baseOptions, runtime)).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({ code: "RELAY_UNAVAILABLE" }),
        );
    });

    it("rejects an empty or invalid production relay list before joining", async () => {
        const { runtime, joinCalls } = createRuntime();

        await expect(
            createTrysteroTransport({ ...baseOptions, relays: [] }, runtime),
        ).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({ code: "NO_VALID_RELAYS" }),
        );
        await expect(
            createTrysteroTransport({ ...baseOptions, relays: ["ws://relay.example"] }, runtime),
        ).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({ code: "NO_VALID_RELAYS" }),
        );
        expect(joinCalls).toHaveLength(0);
    });

    it("snapshots relay settings for each newly created session", async () => {
        const { runtime, joinCalls } = createRuntime();
        const relays = ["wss://relay.example"];
        const creating = createTrysteroTransport({ ...baseOptions, relays }, runtime);
        relays.push("wss://later.example");

        await creating;

        expect(joinCalls[0]?.config).toEqual(
            expect.objectContaining({
                relayConfig: expect.objectContaining({ urls: ["wss://relay.example"] }),
            }),
        );
    });

    it("maps a disconnected send and closes room resources idempotently", async () => {
        vi.useFakeTimers();
        const { runtime, room } = createRuntime();
        const transport = await createTrysteroTransport(baseOptions, runtime);
        room.action.sendError = new Error("Trystero action disconnected: no active peer");

        await expect(transport.send("gone-peer", { type: "hello" })).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({ code: "PEER_DISCONNECTED" }),
        );

        await transport.close();
        await transport.close();
        expect(room.leaveCalls).toBe(1);
        await expect(transport.send("gone-peer", {})).rejects.toEqual(
            expect.objectContaining<Partial<ConnectionError>>({ code: "TRANSPORT_CLOSED" }),
        );
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });
});
