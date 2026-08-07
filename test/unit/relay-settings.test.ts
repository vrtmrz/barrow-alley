import { describe, expect, it } from "vitest";

import {
  DEFAULT_RELAY_SETTINGS,
  RelaySettingsError,
  parseRelayUrls,
  relayUrlsToText,
} from "../../src/transport/relay-settings.js";

describe("relay settings", () => {
  it("trims lines, ignores blanks, removes exact duplicates, and preserves order", () => {
    expect(
      parseRelayUrls([
        "  wss://relay-one.example/path  ",
        "",
        "wss://relay-two.example",
        "wss://relay-one.example/path",
      ].join("\n")),
    ).toEqual(["wss://relay-one.example/path", "wss://relay-two.example"]);
  });

  it("keeps distinct URL spellings rather than silently canonicalising them", () => {
    expect(parseRelayUrls("wss://relay.example\nwss://relay.example/")).toEqual([
      "wss://relay.example",
      "wss://relay.example/",
    ]);
  });

  it.each([
    ["an empty list", "\n \n", "NO_VALID_RELAYS"],
    ["an insecure relay", "ws://relay.example", "INVALID_RELAY_URL"],
    ["an HTTP URL", "https://relay.example", "INVALID_RELAY_URL"],
    ["credentials", "wss://user:password@relay.example", "INVALID_RELAY_URL"],
    ["a fragment", "wss://relay.example/#fragment", "INVALID_RELAY_URL"],
    ["invalid URL syntax", "wss://", "INVALID_RELAY_URL"],
  ] as const)("rejects %s", (_description, input, code) => {
    expect(() => parseRelayUrls(input)).toThrowError(
      expect.objectContaining<Partial<RelaySettingsError>>({ code }),
    );
  });

  it("allows insecure loopback WebSockets only through the explicit test policy", () => {
    expect(
      parseRelayUrls("ws://127.0.0.1:4010", { allowInsecureLoopbackForTests: true }),
    ).toEqual(["ws://127.0.0.1:4010"]);

    expect(() =>
      parseRelayUrls("ws://relay.example", { allowInsecureLoopbackForTests: true }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELAY_URL" }));
  });

  it("ships one validated effective default list", () => {
    expect(parseRelayUrls(relayUrlsToText(DEFAULT_RELAY_SETTINGS.relays))).toEqual(
      DEFAULT_RELAY_SETTINGS.relays,
    );
  });
});
