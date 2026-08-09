import { describe, expect, it } from "vitest";

import { ReceiverSession, SenderSession } from "../../src/core/index.js";
import {
    BrowserPitchController,
    BrowserPitchControllerError,
    type BrowserPitchSnapshot,
} from "../web/src/browser-pitch-controller.js";
import { InMemoryTransportNetwork } from "../../src/transport/index.js";
import type { Transport } from "../../src/transport/transport.js";
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
    readonly #remotePeerId: string;

    constructor(transport: Transport, remotePeerId: string) {
        this.peerId = transport.peerId;
        this.#transport = transport;
        this.#remotePeerId = remotePeerId;
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
        return [this.#remotePeerId];
    }

    onPeerJoin(_handler: PeerEventHandler): () => void {
        return () => {};
    }

    onPeerLeave(_handler: PeerEventHandler): () => void {
        return () => {};
    }

    async waitForPeer(_options?: WaitForPeerOptions): Promise<string> {
        return this.#remotePeerId;
    }
}

class BlockingDiscoveryTransport extends DiscoverableTransport {
    override waitForPeer(options?: WaitForPeerOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            if (options?.signal?.aborted === true) {
                reject(options.signal.reason);
                return;
            }
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
            });
            void resolve;
        });
    }
}

class FailingDiscoveryTransport extends DiscoverableTransport {
    override async waitForPeer(_options?: WaitForPeerOptions): Promise<string> {
        throw new Error("Peer discovery timed out.");
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

describe("BrowserPitchController", () => {
    it("sets up a browser sender and serves an accepted receiver", async () => {
        const network = new InMemoryTransportNetwork();
        const snapshots: BrowserPitchSnapshot[] = [];
        const controller = new BrowserPitchController({
            createTransport: async (options) => {
                expect(options.relays).toEqual(["wss://relay.example"]);
                return new DiscoverableTransport(
                    network.createEndpoint("browser-sender"),
                    "receiver",
                );
            },
            onChange: (snapshot) => snapshots.push(snapshot),
            generateNumber: () => "12345678",
            createSessionId: () => "browser-session",
        });
        const sink = new InMemorySink();
        const receiver = new ReceiverSession({
            clientKind: "obsidian",
            sink,
            transport: network.createEndpoint("receiver"),
        });

        await controller.setUpPitch(source(), { relays: ["wss://relay.example"] });
        await receiver.connect("browser-sender");
        await controller.accept();
        await receiver.requestFile("item-1");

        expect(controller.snapshot).toMatchObject({
            mode: "sender",
            pitchNumber: "1234 5678",
            state: "serving",
        });
        expect(
            snapshots.some((snapshot) =>
                snapshot.mode === "sender" && snapshot.state === "approval-pending"
            ),
        ).toBe(true);
        expect(sink.completed.get("item-1")?.bytes).toEqual(new TextEncoder().encode("notes"));
        await controller.closeActive();
        expect(controller.snapshot).toEqual({ mode: "idle" });
    });

    it("joins a sender, exposes its manifest, and downloads one selected file", async () => {
        const network = new InMemoryTransportNetwork();
        const sender = new SenderSession({
            sessionId: "sender-session",
            source: source(),
            transport: network.createEndpoint("sender"),
        });
        await sender.start();
        const sink = new InMemorySink();
        const controller = new BrowserPitchController({
            createTransport: async () =>
                new DiscoverableTransport(
                    network.createEndpoint("browser-receiver"),
                    "sender",
                ),
        });

        const number = await controller.receivePitch(
            "8765 4321",
            sink,
            { relays: ["wss://relay.example"] },
        );
        await sender.accept();
        await controller.requestFile("item-1");

        expect(number).toBe("87654321");
        expect(controller.snapshot).toMatchObject({
            mode: "receiver",
            pitchNumber: "8765 4321",
            state: "browsing",
            manifest: [{ id: "item-1", displayName: "notes.md" }],
        });
        expect(sink.completed.get("item-1")?.bytes).toEqual(new TextEncoder().encode("notes"));
        await controller.closeActive();
    });

    it("aborts peer discovery on close and permanently rejects work after shutdown", async () => {
        const network = new InMemoryTransportNetwork();
        const controller = new BrowserPitchController({
            createTransport: async () =>
                new BlockingDiscoveryTransport(
                    network.createEndpoint("browser-receiver"),
                    "missing-sender",
                ),
        });
        const joining = controller.receivePitch(
            "12345678",
            new InMemorySink(),
            { relays: ["wss://relay.example"] },
        );
        await waitUntil(() => controller.snapshot.mode === "receiver");

        await controller.closeActive();

        await expect(joining).rejects.toEqual(
            expect.objectContaining<Partial<BrowserPitchControllerError>>({ code: "CANCELLED" }),
        );
        expect(controller.snapshot).toEqual({ mode: "idle" });
        expect(network.endpoint("browser-receiver")).toBeUndefined();

        await controller.shutdown();
        await expect(
            controller.setUpPitch(source(), { relays: ["wss://relay.example"] }),
        ).rejects.toEqual(
            expect.objectContaining<Partial<BrowserPitchControllerError>>({ code: "SHUT_DOWN" }),
        );
    });

    it("returns to the idle chooser after peer discovery fails", async () => {
        const network = new InMemoryTransportNetwork();
        const controller = new BrowserPitchController({
            createTransport: async () =>
                new FailingDiscoveryTransport(
                    network.createEndpoint("browser-receiver"),
                    "missing-sender",
                ),
        });

        await expect(
            controller.receivePitch(
                "12345678",
                new InMemorySink(),
                { relays: ["wss://relay.example"] },
            ),
        ).rejects.toThrow("Peer discovery timed out.");

        expect(controller.snapshot).toEqual({ mode: "idle" });
        expect(network.endpoint("browser-receiver")).toBeUndefined();
    });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for controller state.");
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
