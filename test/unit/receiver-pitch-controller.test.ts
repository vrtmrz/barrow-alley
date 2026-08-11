import { describe, expect, it } from "vitest";

import { type ReceiverState, SenderSession, type TransferProgress } from "../../src/core/index.js";
import {
    type ReceiverDestination,
    ReceiverPitchController,
    type ReceiverPitchView,
    type ReceiverPitchViewActions,
    type ReceiverPitchViewModel,
} from "../../src/obsidian/receiver-pitch-controller.js";
import { InMemoryTransportNetwork } from "../../src/transport/index.js";
import type { Transport } from "../../src/transport/transport.js";
import type { RtcDiagnosticEvent } from "../../src/transport/rtc-diagnostics.js";
import type {
    PeerAwareTransport,
    PeerEventHandler,
    WaitForPeerOptions,
} from "../../src/transport/trystero-transport.js";
import { InMemorySink, InMemorySource } from "../fixtures/in-memory-files.js";

const NOTES_HASH = "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309";

class DiscoverableTransport implements PeerAwareTransport {
    readonly peerId: string;
    readonly #transport: Transport;
    readonly #senderPeerId: string;

    constructor(transport: Transport, senderPeerId: string) {
        this.peerId = transport.peerId;
        this.#transport = transport;
        this.#senderPeerId = senderPeerId;
    }

    send(peerId: string, payload: unknown): Promise<void> {
        return this.#transport.send(peerId, payload);
    }

    onMessage(handler: Parameters<Transport["onMessage"]>[0]): () => void {
        return this.#transport.onMessage(handler);
    }

    close(): Promise<void> {
        return this.#transport.close();
    }

    getPeerIds(): readonly string[] {
        return [this.#senderPeerId];
    }

    onPeerJoin(_handler: PeerEventHandler): () => void {
        return () => {};
    }

    onPeerLeave(_handler: PeerEventHandler): () => void {
        return () => {};
    }

    async waitForPeer(_options?: WaitForPeerOptions): Promise<string> {
        return this.#senderPeerId;
    }
}

class FailingDiscoverableTransport extends DiscoverableTransport {
    readonly #failure: Error;

    constructor(transport: Transport, failure: Error) {
        super(transport, "unreachable-sender");
        this.#failure = failure;
    }

    override async waitForPeer(
        _options?: WaitForPeerOptions,
    ): Promise<string> {
        throw this.#failure;
    }
}

class RecordingView implements ReceiverPitchView {
    readonly model: ReceiverPitchViewModel;
    readonly actions: ReceiverPitchViewActions;
    readonly states: ReceiverState[] = [];
    readonly manifests: string[][] = [];
    readonly progress: TransferProgress[] = [];
    readonly rtcDiagnostics: RtcDiagnosticEvent[] = [];
    opened = false;
    closed = false;

    constructor(
        model: ReceiverPitchViewModel,
        actions: ReceiverPitchViewActions,
    ) {
        this.model = model;
        this.actions = actions;
    }

    open(): void {
        this.opened = true;
    }

    close(): void {
        this.closed = true;
    }

    setState(state: ReceiverState): void {
        this.states.push(state);
    }

    setManifest(items: readonly { readonly displayName: string }[]): void {
        this.manifests.push(items.map((item) => item.displayName));
    }

    setProgress(progress: TransferProgress): void {
        this.progress.push(progress);
    }

    setRtcDiagnostic(event: RtcDiagnosticEvent): void {
        this.rtcDiagnostics.push(event);
    }
}

function source(): InMemorySource {
    return new InMemorySource([
        {
            id: "private/notes.md",
            displayName: "notes.md",
            mimeType: "text/markdown",
            hash: NOTES_HASH,
            chunks: [new TextEncoder().encode("notes")],
        },
    ]);
}

describe("ReceiverPitchController", () => {
    it("joins a pitch, exposes its manifest, and retrieves a prepared file", async () => {
        const network = new InMemoryTransportNetwork();
        const sender = new SenderSession({
            sessionId: "session-1",
            source: source(),
            transport: network.createEndpoint("sender"),
        });
        await sender.start();
        const sink = new InMemorySink();
        const prepared: string[] = [];
        const destination: ReceiverDestination = {
            sink,
            prepare: async (meta) => {
                prepared.push(meta.id);
                return true;
            },
        };
        let view: RecordingView | undefined;
        const controller = new ReceiverPitchController({
            createTransport: async (options) => {
                expect(options.relays).toEqual(["wss://relay.example"]);
                expect(options.roomId).toMatch(/^barrow-alley-/u);
                return new DiscoverableTransport(
                    network.createEndpoint("receiver"),
                    "sender",
                );
            },
            createView(model, actions) {
                view = new RecordingView(model, actions);
                return view;
            },
        });

        const pitchNumber = await controller.receivePitch(
            "1234 5678",
            destination,
            "Incoming",
            { relays: ["wss://relay.example"] },
        );
        await sender.accept();
        await view?.actions.onRequestFile("item-1");

        expect(pitchNumber).toBe("12345678");
        expect(view?.model).toEqual({
            pitchNumber: "1234 5678",
            destination: "Incoming",
        });
        expect(view?.opened).toBe(true);
        expect(view?.manifests.at(-1)).toEqual(["notes.md"]);
        expect(prepared).toEqual(["item-1"]);
        expect(sink.completed.get("item-1")?.bytes).toEqual(
            new TextEncoder().encode("notes"),
        );
        expect(view?.progress.at(-1)).toEqual({
            fileId: "item-1",
            transferredBytes: 5,
            totalBytes: 5,
        });
        await controller.closeActiveReceiver();
    });

    it("does not request a skipped destination and closes resources on shutdown", async () => {
        const network = new InMemoryTransportNetwork();
        const sender = new SenderSession({
            sessionId: "session-2",
            source: source(),
            transport: network.createEndpoint("sender"),
        });
        await sender.start();
        let view: RecordingView | undefined;
        const controller = new ReceiverPitchController({
            createTransport: async () =>
                new DiscoverableTransport(
                    network.createEndpoint("receiver"),
                    "sender",
                ),
            createView(model, actions) {
                view = new RecordingView(model, actions);
                return view;
            },
        });
        const destination: ReceiverDestination = {
            sink: new InMemorySink(),
            prepare: async () => false,
        };

        await controller.receivePitch("87654321", destination, "Vault root", {
            relays: ["wss://relay.example"],
        });
        await sender.accept();
        await view?.actions.onRequestFile("item-1");

        expect(sender.state).toBe("serving");
        expect(view?.states).not.toContain("receiving");
        await controller.shutdown();
        expect(view?.closed).toBe(true);
        expect(view?.states.at(-1)).toBe("closed");
        expect(controller.hasActiveReceiver).toBe(false);
        await expect(
            controller.receivePitch("12345678", destination, "Vault root", {
                relays: ["wss://relay.example"],
            }),
        ).rejects.toThrow(/shut down/iu);
    });

    it("closes a denied attempt before requesting another Pitch number", async () => {
        const network = new InMemoryTransportNetwork();
        const sender = new SenderSession({
            sessionId: "session-denied",
            source: source(),
            transport: network.createEndpoint("sender"),
        });
        await sender.start();
        let view: RecordingView | undefined;
        let retryRequests = 0;
        const controller = new ReceiverPitchController({
            createTransport: async () =>
                new DiscoverableTransport(
                    network.createEndpoint("receiver"),
                    "sender",
                ),
            createView(model, actions) {
                view = new RecordingView(model, actions);
                return view;
            },
            onRetryRequested: () => {
                retryRequests += 1;
            },
        });
        const destination: ReceiverDestination = {
            sink: new InMemorySink(),
            prepare: async () => true,
        };

        await controller.receivePitch("12345678", destination, "Vault root", {
            relays: ["wss://relay.example"],
        });
        await sender.deny();
        expect(view?.states.at(-1)).toBe("denied");

        await view?.actions.onRetry();

        expect(view?.closed).toBe(true);
        expect(view?.states.at(-1)).toBe("closed");
        expect(retryRequests).toBe(1);
        expect(controller.hasActiveReceiver).toBe(false);
    });

    it("keeps a failed connection attempt open so another number can be tried", async () => {
        const network = new InMemoryTransportNetwork();
        const failure = new Error("No sender joined this pitch.");
        let view: RecordingView | undefined;
        let retryRequests = 0;
        const controller = new ReceiverPitchController({
            createTransport: async () =>
                new FailingDiscoverableTransport(
                    network.createEndpoint("receiver"),
                    failure,
                ),
            createView(model, actions) {
                view = new RecordingView(model, actions);
                return view;
            },
            onRetryRequested: () => {
                retryRequests += 1;
            },
        });
        const destination: ReceiverDestination = {
            sink: new InMemorySink(),
            prepare: async () => true,
        };

        await expect(
            controller.receivePitch("12345678", destination, "Vault root", {
                relays: ["wss://relay.example"],
            }),
        ).rejects.toBe(failure);

        expect(view?.opened).toBe(true);
        expect(view?.closed).toBe(false);
        expect(view?.states.at(-1)).toBe("failed");
        expect(controller.hasActiveReceiver).toBe(true);

        await view?.actions.onRetry();
        expect(view?.closed).toBe(true);
        expect(retryRequests).toBe(1);
        expect(controller.hasActiveReceiver).toBe(false);
    });
});
