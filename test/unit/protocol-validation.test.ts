import { describe, expect, it } from "vitest";

import {
  BARROW_ALLEY_PROTOCOL_VERSION,
  ProtocolValidationError,
  parseProtocolMessage,
} from "../../src/core/index.js";

const HASH = "ab".repeat(32);

describe("protocol message validation", () => {
  it("accepts and normalises valid admission and manifest messages", () => {
    expect(
      parseProtocolMessage({
        type: "hello",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        clientKind: "obsidian",
      }),
    ).toEqual({
      type: "hello",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      clientKind: "obsidian",
    });

    expect(
      parseProtocolMessage({
        type: "connection-request",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        clientKind: "browser",
      }),
    ).toEqual({
      type: "connection-request",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      clientKind: "browser",
    });

    expect(
      parseProtocolMessage({
        type: "manifest",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
        sessionId: "session-1",
        items: [
          {
            id: "item-1",
            displayName: "notes.md",
            size: 12,
            mimeType: "text/markdown",
            hash: HASH.toUpperCase(),
          },
        ],
      }),
    ).toEqual({
      type: "manifest",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: "session-1",
      items: [
        {
          id: "item-1",
          displayName: "notes.md",
          size: 12,
          mimeType: "text/markdown",
          hash: HASH,
        },
      ],
    });
  });

  it("rejects incompatible protocol versions explicitly", () => {
    expect(() =>
      parseProtocolMessage({
        type: "connection-request",
        protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION + 1,
        clientKind: "browser",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolValidationError>>({
        code: "INCOMPATIBLE_PROTOCOL",
      }),
    );
  });

  it("rejects malformed metadata and duplicate manifest IDs", () => {
    const base = {
      type: "manifest",
      protocolVersion: BARROW_ALLEY_PROTOCOL_VERSION,
      sessionId: "session-1",
    };
    expect(() =>
      parseProtocolMessage({
        ...base,
        items: [{ id: "item-1", displayName: "notes.md", size: -1, hash: HASH }],
      }),
    ).toThrowError(ProtocolValidationError);
    expect(() =>
      parseProtocolMessage({
        ...base,
        items: [
          { id: "item-1", displayName: "one.md", size: 1, hash: HASH },
          { id: "item-1", displayName: "two.md", size: 2, hash: HASH },
        ],
      }),
    ).toThrowError(/unique/u);
  });
});
