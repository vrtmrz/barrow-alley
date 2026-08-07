import process from "node:process";

import { RTCPeerConnection } from "werift";

import { ReceiverSession, SenderSession } from "../../src/core/index.js";
import {
  createTrysteroTransport,
  type RtcDiagnosticEvent,
} from "../../src/transport/index.js";
import { InMemorySink, InMemorySource } from "../fixtures/in-memory-files.js";

const role = process.env.BARROW_ALLEY_TEST_ROLE;
const relay = process.env.BARROW_ALLEY_TEST_RELAY;
if (role !== "sender" && role !== "receiver") throw new Error("Unknown test peer role.");
if (relay === undefined) throw new Error("Missing local relay URL.");
if (process.send === undefined) throw new Error("The test peer requires an IPC parent.");

const rtcDiagnostics: RtcDiagnosticEvent[] = [];

const transport = await createTrysteroTransport({
  roomId: "barrow-alley-local-interoperability",
  password: "barrow-alley-local-interoperability-password",
  relays: [relay],
  allowInsecureLoopbackForTests: true,
  relayConnectionTimeoutMs: 10_000,
  peerConnectionTimeoutMs: 30_000,
  rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  rtcDiagnostics: (event) => rtcDiagnostics.push(event),
});

if (role === "sender") await runSender();
else await runReceiver();

async function runSender(): Promise<void> {
  const source = new InMemorySource([
    {
      id: "local/notes.md",
      displayName: "notes.md",
      mimeType: "text/markdown",
      hash: "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309",
      chunks: [new TextEncoder().encode("notes")],
    },
  ]);
  const session = new SenderSession({
    sessionId: "local-session",
    source,
    transport,
  });
  await session.start();
  sendToParent({ type: "ready", role, peerId: transport.peerId });
  await waitUntil(() => session.state === "approval-pending", 30_000);
  sendToParent({ type: "approval-pending", peerId: session.pendingPeerId });
  await waitForParentCommand("accept");
  await session.accept();
  sendToParent({ type: "serving", peerId: session.authorisedPeerId });
  await waitForParentCommand("close");
  await session.close();
  await sendFinalToParent({
    type: "closed",
    role,
    state: session.state,
    rtcConnectedEvents: countConnectedRtcEvents(),
    rtcFailureEvents: rtcDiagnostics.filter((event) => event.type === "failure").length,
    activeResources: process.getActiveResourcesInfo(),
  });
}

async function runReceiver(): Promise<void> {
  sendToParent({ type: "ready", role, peerId: transport.peerId });
  const senderPeerId = await transport.waitForPeer();
  const receivedMessages: unknown[] = [];
  transport.onMessage((_peerId, payload) => {
    receivedMessages.push(payload);
  });
  const session = new ReceiverSession({
    clientKind: "browser",
    sink: new InMemorySink(),
    transport,
  });
  await session.connect(senderPeerId);
  sendToParent({
    type: "awaiting-approval",
    senderPeerId,
    receivedMessages: [...receivedMessages],
    manifest: session.manifest,
  });
  await waitUntil(() => session.state === "browsing", 30_000);
  sendToParent({
    type: "browsing",
    manifest: session.manifest,
    receivedMessages,
  });
  await waitUntil(() => session.state === "closed", 30_000);
  await sendFinalToParent({
    type: "closed",
    role,
    state: session.state,
    rtcConnectedEvents: countConnectedRtcEvents(),
    rtcFailureEvents: rtcDiagnostics.filter((event) => event.type === "failure").length,
    activeResources: process.getActiveResourcesInfo(),
  });
}

function countConnectedRtcEvents(): number {
  return rtcDiagnostics.filter(
    (event) => event.type === "status" && event.connectionState === "connected",
  ).length;
}

function sendToParent(message: unknown): void {
  process.send?.(message);
}

function sendFinalToParent(message: unknown): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    process.send?.(message, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      process.exit(0);
    });
  });
}

function waitForParentCommand(command: string): Promise<void> {
  return new Promise((resolve) => {
    const handler = (message: unknown): void => {
      if (!isRecord(message) || message.type !== command) return;
      process.off("message", handler);
      resolve();
    };
    process.on("message", handler);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the peer state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
