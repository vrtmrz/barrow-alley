import { describe, expect, it } from "vitest";

import {
  BARROW_ALLEY_PROTOCOL_VERSION,
  ReceiverSession,
  SenderSession,
  SessionError,
} from "../../src/core/index.js";
import { InMemoryTransportNetwork } from "../../src/transport/index.js";
import { InMemorySink, InMemorySource } from "../fixtures/in-memory-files.js";

const FIRST_HASH = "01".repeat(32);
const SECOND_HASH = "02".repeat(32);

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
});
