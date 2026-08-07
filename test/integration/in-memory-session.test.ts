import { describe, expect, it } from "vitest";

import {
  BARROW_ALLEY_PROTOCOL_VERSION,
  ReceiverSession,
  SenderSession,
  SessionError,
} from "../../src/core/index.js";
import { InMemoryTransportNetwork } from "../../src/transport/index.js";
import { InMemorySink, InMemorySource } from "../fixtures/in-memory-files.js";

const FIRST_HASH = "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309";
const SECOND_HASH = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

function createFiles(): InMemorySource {
  return new InMemorySource([
    {
      id: "vault/notes.md",
      displayName: "notes.md",
      mimeType: "text/markdown",
      hash: FIRST_HASH,
      chunks: [new TextEncoder().encode("notes")],
    },
    {
      id: "vault/diagram.png",
      displayName: "diagram.png",
      mimeType: "image/png",
      hash: SECOND_HASH,
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
    },
  ]);
}

describe("in-memory sessions", () => {
  it("reports sender lifecycle changes to a presentation observer", async () => {
    const network = new InMemoryTransportNetwork();
    const states: string[] = [];
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: network.createEndpoint("sender"),
      onStateChange(state) {
        states.push(state);
      },
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink: new InMemorySink(),
      transport: network.createEndpoint("receiver"),
    });

    await sender.start();
    await receiver.connect("sender");
    await sender.deny();
    await sender.close();

    expect(states).toEqual([
      "preparing",
      "waiting-for-peer",
      "approval-pending",
      "waiting-for-peer",
      "closing",
      "closed",
    ]);
  });

  it("discloses the manifest only after acceptance and retrieves one selected file", async () => {
    const network = new InMemoryTransportNetwork();
    const senderTransport = network.createEndpoint("sender");
    const receiverTransport = network.createEndpoint("receiver");
    const receivedMessages: unknown[] = [];
    receiverTransport.onMessage((_peerId, payload) => {
      receivedMessages.push(payload);
    });
    const sink = new InMemorySink();
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: senderTransport,
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink,
      transport: receiverTransport,
    });

    await sender.start();
    await receiver.connect("sender");

    expect(sender.state).toBe("approval-pending");
    expect(receiver.state).toBe("awaiting-approval");
    expect(receiver.manifest).toBeUndefined();
    expect(receivedMessages).toEqual([]);

    await sender.accept();

    expect(sender.state).toBe("serving");
    expect(receiver.state).toBe("browsing");
    expect(receiver.manifest?.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: "item-1", displayName: "notes.md" },
      { id: "item-2", displayName: "diagram.png" },
    ]);
    expect(JSON.stringify(receiver.manifest)).not.toContain("vault/");

    await expect(receiver.requestFile("not-in-manifest")).rejects.toMatchObject({
      code: "UNKNOWN_FILE",
    } satisfies Partial<SessionError>);
    await receiver.requestFile("item-2");

    expect(sender.state).toBe("serving");
    expect(receiver.state).toBe("browsing");
    expect([...sink.completed.keys()]).toEqual(["item-2"]);
    expect(sink.completed.get("item-2")?.bytes).toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  it("denies a receiver without disclosing file metadata", async () => {
    const network = new InMemoryTransportNetwork();
    const senderTransport = network.createEndpoint("sender");
    const receiverTransport = network.createEndpoint("receiver");
    const receivedMessages: unknown[] = [];
    receiverTransport.onMessage((_peerId, payload) => {
      receivedMessages.push(payload);
    });
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: senderTransport,
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink: new InMemorySink(),
      transport: receiverTransport,
    });

    await sender.start();
    await receiver.connect("sender");
    await sender.deny();

    expect(sender.state).toBe("waiting-for-peer");
    expect(receiver.state).toBe("denied");
    expect(receiver.manifest).toBeUndefined();
    expect(receivedMessages).toEqual([
      {
        type: "deny",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        reason: "denied",
      },
    ]);
    expect(JSON.stringify(receivedMessages)).not.toMatch(/notes|diagram|hash|size/iu);
  });

  it("keeps an accepted receiver exclusive when a second receiver joins", async () => {
    const network = new InMemoryTransportNetwork();
    const senderTransport = network.createEndpoint("sender");
    const firstTransport = network.createEndpoint("receiver-one");
    const secondTransport = network.createEndpoint("receiver-two");
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: senderTransport,
    });
    const first = new ReceiverSession({
      clientKind: "browser",
      sink: new InMemorySink(),
      transport: firstTransport,
    });
    const second = new ReceiverSession({
      clientKind: "obsidian",
      sink: new InMemorySink(),
      transport: secondTransport,
    });

    await sender.start();
    await first.connect("sender");
    await sender.accept();
    await second.connect("sender");

    expect(sender.authorisedPeerId).toBe("receiver-one");
    expect(first.state).toBe("browsing");
    expect(second.state).toBe("denied");
    expect(second.manifest).toBeUndefined();

    const rogueTransport = network.createEndpoint("rogue");
    const rogueMessages: unknown[] = [];
    rogueTransport.onMessage((_peerId, payload) => {
      rogueMessages.push(payload);
    });
    await rogueTransport.send("sender", {
      type: "request-file",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: "session-1",
      fileId: "item-1",
    });

    expect(sender.state).toBe("serving");
    expect(rogueMessages).toEqual([
      {
        type: "error",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        code: "SESSION_CLOSED",
      },
    ]);

    await rogueTransport.send("sender", {
      type: "cancel-session",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: "session-1",
    });
    expect(sender.state).toBe("serving");
  });

  it("rejects an incompatible connection request without leaving the waiting state", async () => {
    const network = new InMemoryTransportNetwork();
    const senderTransport = network.createEndpoint("sender");
    const peerTransport = network.createEndpoint("peer");
    const receivedMessages: unknown[] = [];
    peerTransport.onMessage((_peerId, payload) => {
      receivedMessages.push(payload);
    });
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: senderTransport,
    });

    await sender.start();
    await peerTransport.send("sender", {
      type: "connection-request",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION + 1,
      clientKind: "browser",
    });

    expect(sender.state).toBe("waiting-for-peer");
    expect(receivedMessages).toEqual([
      {
        type: "deny",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        reason: "incompatible",
      },
    ]);
  });

  it("closes both sides idempotently while approval is pending", async () => {
    const network = new InMemoryTransportNetwork();
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: network.createEndpoint("sender"),
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink: new InMemorySink(),
      transport: network.createEndpoint("receiver"),
    });

    await sender.start();
    await receiver.connect("sender");
    await Promise.all([sender.close(), sender.close()]);
    await Promise.all([receiver.close(), receiver.close()]);

    expect(sender.state).toBe("closed");
    expect(receiver.state).toBe("closed");
    expect(network.endpoint("sender")).toBeUndefined();
    expect(network.endpoint("receiver")).toBeUndefined();
  });

  it("detects a source changed after manifest preparation", async () => {
    const network = new InMemoryTransportNetwork();
    const source = createFiles();
    const sink = new InMemorySink();
    const sender = new SenderSession({
      sessionId: "session-1",
      source,
      transport: network.createEndpoint("sender"),
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink,
      transport: network.createEndpoint("receiver"),
    });

    await sender.start();
    await receiver.connect("sender");
    await sender.accept();
    source.replaceBytes("vault/notes.md", new TextEncoder().encode("changed"));

    await expect(receiver.requestFile("item-1")).rejects.toMatchObject({
      code: "PEER_ERROR",
    } satisfies Partial<SessionError>);
    expect(sender.state).toBe("failed");
    expect(receiver.state).toBe("failed");
    expect(receiver.peerError).toBe("SOURCE_CHANGED");
    expect(sink.completed.size).toBe(0);
  });

  it("cancels between bounded chunks and leaves no completed destination", async () => {
    const network = new InMemoryTransportNetwork();
    const sink = new InMemorySink();
    let cancellation: Promise<void> | undefined;
    let receiver: ReceiverSession;
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: network.createEndpoint("sender"),
      chunkSize: 2,
    });
    receiver = new ReceiverSession({
      clientKind: "browser",
      sink,
      transport: network.createEndpoint("receiver"),
      onProgress: ({ transferredBytes }) => {
        if (transferredBytes === 2) cancellation ??= receiver.cancelFile();
      },
    });

    await sender.start();
    await receiver.connect("sender");
    await sender.accept();
    await receiver.requestFile("item-2");
    await cancellation;

    expect(sender.state).toBe("serving");
    expect(receiver.state).toBe("browsing");
    expect(sink.completed.size).toBe(0);
    expect(sink.aborted).toContain("item-2");
  });

  it("detects a chunk corrupted across the transport boundary", async () => {
    let corrupted = false;
    const network = new InMemoryTransportNetwork({
      transformMessage: ({ senderPeerId, payload }) => {
        if (
          !corrupted &&
          senderPeerId === "sender" &&
          typeof payload === "object" &&
          payload !== null &&
          "type" in payload &&
          payload.type === "file-chunk" &&
          "data" in payload &&
          payload.data instanceof Uint8Array
        ) {
          corrupted = true;
          const data = payload.data.slice();
          data[0] = (data[0] ?? 0) ^ 0xff;
          return { ...payload, data };
        }
        return payload;
      },
    });
    const sink = new InMemorySink();
    const sender = new SenderSession({
      sessionId: "session-1",
      source: createFiles(),
      transport: network.createEndpoint("sender"),
      chunkSize: 2,
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink,
      transport: network.createEndpoint("receiver"),
    });

    await sender.start();
    await receiver.connect("sender");
    await sender.accept();

    await expect(receiver.requestFile("item-2")).rejects.toMatchObject({
      code: "PEER_ERROR",
    } satisfies Partial<SessionError>);
    expect(corrupted).toBe(true);
    expect(sender.state).toBe("failed");
    expect(receiver.state).toBe("failed");
    expect(receiver.peerError).toBe("HASH_MISMATCH");
    expect(sink.completed.size).toBe(0);
    expect(sink.aborted).toContain("item-2");
  });
});
