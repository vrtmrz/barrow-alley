import { describe, expect, it } from "vitest";

import type {
  SenderState,
  TransferProgress,
} from "../../src/core/index.js";
import {
  BARROW_ALLEY_PROTOCOL_VERSION,
  ReceiverSession,
} from "../../src/core/index.js";
import {
  SenderPitchController,
  type SenderPitchView,
  type SenderPitchViewActions,
  type SenderPitchViewModel,
} from "../../src/obsidian/sender-pitch-controller.js";
import {
  ObsidianVaultSource,
  type VaultBinaryFile,
  type VaultBinaryReader,
} from "../../src/obsidian/vault-source.js";
import { InMemoryTransportNetwork } from "../../src/transport/index.js";
import { InMemorySink, InMemorySource } from "../fixtures/in-memory-files.js";

const NOTES_HASH = "ab5aa97074c454a0632057e704220d9a6678fbf773a0a5806fc09b8173b07309";

class RecordingView implements SenderPitchView {
  readonly model: SenderPitchViewModel;
  readonly actions: SenderPitchViewActions;
  readonly states: SenderState[] = [];
  readonly progress: TransferProgress[] = [];
  opened = false;
  closed = false;

  constructor(model: SenderPitchViewModel, actions: SenderPitchViewActions) {
    this.model = model;
    this.actions = actions;
  }

  open(): void {
    this.opened = true;
  }

  close(): void {
    this.closed = true;
  }

  setState(state: SenderState): void {
    this.states.push(state);
  }

  setProgress(progress: TransferProgress): void {
    this.progress.push(progress);
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

describe("SenderPitchController", () => {
  it("serves a selected Vault file to an in-memory receiver after UI acceptance", async () => {
    const selected: VaultBinaryFile = {
      path: "private/notes.md",
      name: "notes.md",
      extension: "md",
      stat: { size: 5, mtime: 10 },
    };
    const reader: VaultBinaryReader = {
      readBinary: async () => new TextEncoder().encode("notes").buffer,
    };
    const network = new InMemoryTransportNetwork();
    const sink = new InMemorySink();
    let view: RecordingView | undefined;
    const controller = new SenderPitchController({
      createTransport: async () => network.createEndpoint("sender"),
      createView(model, actions) {
        view = new RecordingView(model, actions);
        return view;
      },
      generateNumber: () => "12345678",
      createSessionId: () => "session-vault",
    });
    const receiver = new ReceiverSession({
      clientKind: "browser",
      sink,
      transport: network.createEndpoint("receiver"),
    });

    await controller.setUpPitch(new ObsidianVaultSource(reader, [selected]), {
      relays: ["wss://relay.example"],
    });
    await receiver.connect("sender");
    await view?.actions.onAccept();
    await receiver.requestFile("item-1");

    expect(sink.completed.get("item-1")?.bytes).toEqual(new TextEncoder().encode("notes"));
    expect(view?.progress.at(-1)).toEqual({
      fileId: "item-1",
      transferredBytes: 5,
      totalBytes: 5,
    });
    await controller.closeActivePitch();
  });

  it("bridges approval actions and closes the session when the view closes", async () => {
    const network = new InMemoryTransportNetwork();
    const senderTransport = network.createEndpoint("sender");
    const receiverTransport = network.createEndpoint("receiver");
    let view: RecordingView | undefined;
    const controller = new SenderPitchController({
      createTransport: async (options) => {
        expect(options.relays).toEqual(["wss://relay.example"]);
        expect(options.roomId).toMatch(/^barrow-alley-/u);
        return senderTransport;
      },
      createView(model, actions) {
        view = new RecordingView(model, actions);
        return view;
      },
      generateNumber: () => "12345678",
      createSessionId: () => "session-1",
    });

    const pitchNumber = await controller.setUpPitch(source(), {
      relays: ["wss://relay.example"],
    });

    expect(pitchNumber).toBe("12345678");
    expect(view?.model).toEqual({
      pitchNumber: "1234 5678",
      files: ["notes.md"],
    });
    expect(view?.opened).toBe(true);
    expect(view?.states.at(-1)).toBe("waiting-for-peer");

    await receiverTransport.send("sender", {
      type: "connection-request",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      clientKind: "browser",
    });
    expect(view?.states.at(-1)).toBe("approval-pending");

    await view?.actions.onDeny();
    expect(view?.states.at(-1)).toBe("waiting-for-peer");

    await receiverTransport.send("sender", {
      type: "connection-request",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      clientKind: "browser",
    });
    await view?.actions.onAccept();
    expect(view?.states.at(-1)).toBe("serving");

    await view?.actions.onClose();
    expect(view?.states.at(-1)).toBe("closed");
    expect(controller.hasActivePitch).toBe(false);
    await expect(
      receiverTransport.send("sender", {
        type: "connection-request",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        clientKind: "browser",
      }),
    ).rejects.toThrow(/unavailable/iu);
  });

  it("closes both the session and its view on shutdown, then rejects new pitches", async () => {
    const network = new InMemoryTransportNetwork();
    let view: RecordingView | undefined;
    const controller = new SenderPitchController({
      createTransport: async () => network.createEndpoint("sender"),
      createView(model, actions) {
        view = new RecordingView(model, actions);
        return view;
      },
      generateNumber: () => "87654321",
      createSessionId: () => "session-2",
    });

    await controller.setUpPitch(source(), { relays: ["wss://relay.example"] });
    await controller.shutdown();

    expect(view?.closed).toBe(true);
    expect(view?.states.at(-1)).toBe("closed");
    expect(controller.hasActivePitch).toBe(false);
    await expect(
      controller.setUpPitch(source(), { relays: ["wss://relay.example"] }),
    ).rejects.toThrow(/shut down/iu);
  });
});
